//go:build !windows && !linux

package updatecheck

import "syscall"

func windowsDetachProcess() *syscall.SysProcAttr {
	return nil
}

func linuxDetachProcess() *syscall.SysProcAttr {
	return nil
}