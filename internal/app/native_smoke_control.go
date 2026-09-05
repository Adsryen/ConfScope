package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type nativeSmokeControl struct {
	baseURL string
	execJS  func(script string)
	server  *http.Server

	mu      sync.Mutex
	pending map[string]chan nativeSmokeEvalResult
}

type nativeSmokeEvalRequest struct {
	Script    string `json:"script"`
	TimeoutMS int    `json:"timeoutMs"`
}

type nativeSmokeEvalResult struct {
	ID    string          `json:"id"`
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value,omitempty"`
	Error string          `json:"error,omitempty"`
}

func nativeSmokeControlPortFromEnv(getenv func(string) string) (int, bool, error) {
	raw := getenv("CONFSCOPE_NATIVE_SMOKE_CONTROL_PORT")
	if raw == "" {
		return 0, false, nil
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, false, fmt.Errorf("invalid CONFSCOPE_NATIVE_SMOKE_CONTROL_PORT: %q", raw)
	}
	return port, true, nil
}

func newNativeSmokeControl(baseURL string, execJS func(script string)) *nativeSmokeControl {
	return &nativeSmokeControl{
		baseURL: baseURL,
		execJS:  execJS,
		pending: make(map[string]chan nativeSmokeEvalResult),
	}
}

func (c *nativeSmokeControl) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", c.withCORS(c.handleHealth))
	mux.HandleFunc("/eval", c.withCORS(c.handleEval))
	mux.HandleFunc("/result", c.withCORS(c.handleResult))
	return mux
}

func (c *nativeSmokeControl) start(port int) {
	c.server = &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", port),
		Handler:           c.handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := c.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			println("Native smoke control error:", err.Error())
		}
	}()
}

func (c *nativeSmokeControl) stop(ctx context.Context) {
	if c == nil || c.server == nil {
		return
	}
	_ = c.server.Shutdown(ctx)
}

func (c *nativeSmokeControl) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (c *nativeSmokeControl) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeNativeSmokeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (c *nativeSmokeControl) handleEval(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req nativeSmokeEvalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("decode request: %v", err), http.StatusBadRequest)
		return
	}
	if req.Script == "" {
		http.Error(w, "script is required", http.StatusBadRequest)
		return
	}
	timeout := time.Duration(req.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	id, err := nativeSmokeID()
	if err != nil {
		http.Error(w, fmt.Sprintf("create eval id: %v", err), http.StatusInternalServerError)
		return
	}
	ch := make(chan nativeSmokeEvalResult, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	defer c.removePending(id)

	c.execJS(c.evalScript(id, req.Script))

	select {
	case result := <-ch:
		if !result.OK {
			http.Error(w, result.Error, http.StatusInternalServerError)
			return
		}
		writeNativeSmokeJSON(w, http.StatusOK, map[string]any{"ok": true, "value": result.Value})
	case <-time.After(timeout):
		http.Error(w, "native smoke eval timed out", http.StatusGatewayTimeout)
	}
}

func (c *nativeSmokeControl) handleResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var result nativeSmokeEvalResult
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		http.Error(w, fmt.Sprintf("decode result: %v", err), http.StatusBadRequest)
		return
	}
	c.complete(result)
	writeNativeSmokeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (c *nativeSmokeControl) complete(result nativeSmokeEvalResult) {
	c.mu.Lock()
	ch := c.pending[result.ID]
	c.mu.Unlock()
	if ch == nil {
		return
	}
	ch <- result
}

func (c *nativeSmokeControl) removePending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *nativeSmokeControl) evalScript(id string, script string) string {
	resultURL := c.baseURL + "/result"
	idJSON, _ := json.Marshal(id)
	urlJSON, _ := json.Marshal(resultURL)
	return fmt.Sprintf(`(() => {
  const __confscopeNativeSmokeID = %s;
  const __confscopeNativeSmokeResultURL = %s;
  (async () => {
    try {
      const value = await (async () => {
%s
      })();
      await fetch(__confscopeNativeSmokeResultURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: __confscopeNativeSmokeID, ok: true, value: value === undefined ? null : value })
      });
    } catch (error) {
      await fetch(__confscopeNativeSmokeResultURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: __confscopeNativeSmokeID, ok: false, error: String(error && (error.stack || error.message || error)) })
      });
    }
  })();
})();`, idJSON, urlJSON, script)
}

func nativeSmokeID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

func writeNativeSmokeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (a *App) startNativeSmokeControl(ctx context.Context) {
	port, ok, err := nativeSmokeControlPortFromEnv(os.Getenv)
	if err != nil {
		println("Native smoke control disabled:", err.Error())
		return
	}
	if !ok {
		return
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	control := newNativeSmokeControl(baseURL, func(script string) {
		runtime.WindowExecJS(ctx, script)
	})
	control.start(port)
	a.nativeSmokeControl = control
}

func (a *App) stopNativeSmokeControl() {
	if a.nativeSmokeControl == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	a.nativeSmokeControl.stop(ctx)
	a.nativeSmokeControl = nil
}
