// Package task 提供任务中心管理功能。
package task

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

var taskCounter int64

// TaskStatus 任务状态类型。
type TaskStatus string

const (
	TaskStatusPending   TaskStatus = "pending"
	TaskStatusRunning   TaskStatus = "running"
	TaskStatusSuccess   TaskStatus = "success"
	TaskStatusFailed    TaskStatus = "failed"
	TaskStatusCancelled TaskStatus = "cancelled"
)

// TaskType 任务类型。
type TaskType string

const (
	TaskTypeExport  TaskType = "export"
	TaskTypeBackup  TaskType = "backup"
	TaskTypeApply   TaskType = "apply"
	TaskTypeRestore TaskType = "restore"
)

// Task 表示一个任务。
type Task struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Type        TaskType   `json:"type"`
	Status      TaskStatus `json:"status"`
	Progress    int        `json:"progress"`   // 0-100
	Total       int        `json:"total"`       // 总数
	Completed   int        `json:"completed"`   // 已完成数
	Failed      int        `json:"failed"`      // 失败数
	Error       string     `json:"error"`       // 错误信息
	StartTime   time.Time  `json:"startTime"`
	EndTime     *time.Time `json:"endTime"`
	ElapsedTime int64      `json:"elapsedTime"` // 耗时(毫秒)
}

// TaskManager 任务管理器。
type TaskManager struct {
	mu     sync.RWMutex
	tasks  map[string]*Task
	cancel map[string]chan struct{}
}

// NewTaskManager 创建任务管理器。
func NewTaskManager() *TaskManager {
	return &TaskManager{
		tasks:  make(map[string]*Task),
		cancel: make(map[string]chan struct{}),
	}
}

// CreateTask 创建新任务。
func (m *TaskManager) CreateTask(name string, taskType TaskType) *Task {
	m.mu.Lock()
	defer m.mu.Unlock()

	id := atomic.AddInt64(&taskCounter, 1)
	task := &Task{
		ID:        fmt.Sprintf("task_%d_%d", time.Now().UnixMilli(), id),
		Name:      name,
		Type:      taskType,
		Status:    TaskStatusPending,
		StartTime: time.Now(),
	}

	m.tasks[task.ID] = task
	m.cancel[task.ID] = make(chan struct{})

	return task
}

// GetTask 获取任务。
func (m *TaskManager) GetTask(id string) (*Task, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	task, ok := m.tasks[id]
	return task, ok
}

// ListTasks 列出所有任务。
func (m *TaskManager) ListTasks() []*Task {
	m.mu.RLock()
	defer m.mu.RUnlock()

	tasks := make([]*Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		tasks = append(tasks, t)
	}
	return tasks
}

// StartTask 开始执行任务。
func (m *TaskManager) StartTask(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	task, ok := m.tasks[id]
	if !ok {
		return fmt.Errorf("任务不存在: %s", id)
	}

	if task.Status != TaskStatusPending {
		return fmt.Errorf("任务状态不允许启动: %s", task.Status)
	}

	task.Status = TaskStatusRunning
	return nil
}

// UpdateProgress 更新任务进度。
func (m *TaskManager) UpdateProgress(id string, completed, failed int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	task, ok := m.tasks[id]
	if !ok {
		return fmt.Errorf("任务不存在: %s", id)
	}

	task.Completed = completed
	task.Failed = failed
	if task.Total > 0 {
		task.Progress = (completed + failed) * 100 / task.Total
	}

	return nil
}

// CompleteTask 完成任务。
func (m *TaskManager) CompleteTask(id string, success bool, errMsg string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	task, ok := m.tasks[id]
	if !ok {
		return fmt.Errorf("任务不存在: %s", id)
	}

	now := time.Now()
	task.EndTime = &now
	task.ElapsedTime = now.Sub(task.StartTime).Milliseconds()

	if success {
		task.Status = TaskStatusSuccess
		task.Progress = 100
	} else {
		task.Status = TaskStatusFailed
		task.Error = errMsg
	}

	// 关闭取消通道
	if cancelCh, ok := m.cancel[id]; ok {
		close(cancelCh)
		delete(m.cancel, id)
	}

	return nil
}

// CancelTask 取消任务。
func (m *TaskManager) CancelTask(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	task, ok := m.tasks[id]
	if !ok {
		return fmt.Errorf("任务不存在: %s", id)
	}

	if task.Status != TaskStatusRunning && task.Status != TaskStatusPending {
		return fmt.Errorf("任务状态不允许取消: %s", task.Status)
	}

	now := time.Now()
	task.EndTime = &now
	task.ElapsedTime = now.Sub(task.StartTime).Milliseconds()
	task.Status = TaskStatusCancelled

	// 发送取消信号
	if cancelCh, ok := m.cancel[id]; ok {
		close(cancelCh)
		delete(m.cancel, id)
	}

	return nil
}

// IsCancelled 检查任务是否已取消。
func (m *TaskManager) IsCancelled(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	task, ok := m.tasks[id]
	if !ok {
		return false
	}
	return task.Status == TaskStatusCancelled
}

// CancelChan 获取取消信号通道。
func (m *TaskManager) CancelChan(id string) <-chan struct{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if ch, ok := m.cancel[id]; ok {
		return ch
	}
	return nil
}

// DeleteTask 删除任务。
func (m *TaskManager) DeleteTask(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	task, ok := m.tasks[id]
	if !ok {
		return fmt.Errorf("任务不存在: %s", id)
	}

	if task.Status == TaskStatusRunning {
		return fmt.Errorf("运行中的任务不能删除")
	}

	// 关闭取消通道
	if cancelCh, ok := m.cancel[id]; ok {
		close(cancelCh)
		delete(m.cancel, id)
	}

	delete(m.tasks, id)
	return nil
}

// ClearCompleted 清除已完成的任务。
func (m *TaskManager) ClearCompleted() {
	m.mu.Lock()
	defer m.mu.Unlock()

	var toDelete []string
	for id, task := range m.tasks {
		if task.Status != TaskStatusRunning && task.Status != TaskStatusPending {
			toDelete = append(toDelete, id)
		}
	}

	for _, id := range toDelete {
		if cancelCh, ok := m.cancel[id]; ok {
			close(cancelCh)
			delete(m.cancel, id)
		}
		delete(m.tasks, id)
	}
}
