//go:build linux

package updatecheck

import "syscall"

func windowsDetachProcess() *syscall.SysProcAttr {
	return nil
}

func linuxDetachProcess() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		Setsid: true,
	}
}