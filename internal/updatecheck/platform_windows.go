//go:build windows

package updatecheck

import "syscall"

func windowsDetachProcess() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}

func linuxDetachProcess() *syscall.SysProcAttr {
	return nil
}