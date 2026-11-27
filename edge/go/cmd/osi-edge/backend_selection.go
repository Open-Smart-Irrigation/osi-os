package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const backendCheckInterval = 5 * time.Second

type backendSelection struct {
	procRoot   string
	choicePath string
}

func runtimeSelection() backendSelection {
	procRoot := os.Getenv("OSI_EDGE_PROC_ROOT")
	choice := imagePath("/etc/osi-backend")
	if procRoot == "" {
		procRoot = "/proc"
		if os.Getenv("OSI_EDGE_TEST_HOOKS") == "1" {
			// T1 runs an isolated backend without the image's init script.
			choice = ""
		}
	}
	return backendSelection{procRoot, choice}
}

func (s backendSelection) check() error {
	processes, err := os.ReadDir(s.procRoot)
	if err != nil {
		return fmt.Errorf("read process directory: %w", err)
	}
	for _, proc := range processes {
		if _, err := strconv.ParseUint(proc.Name(), 10, 32); !proc.IsDir() || err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join(s.procRoot, proc.Name(), "cmdline"))
		if err != nil {
			continue // a process can exit during the scan
		}
		args := bytes.Split(cmdline, []byte{0})
		// Node-RED sets its process title once its listener is up.
		if string(args[0]) == "node-red" {
			return fmt.Errorf("Node-RED is running")
		}
		for _, arg := range args {
			if string(arg) == "/usr/lib/node/node-red/red.js" {
				return fmt.Errorf("Node-RED is running")
			}
		}
	}
	if s.choicePath != "" {
		raw, _ := os.ReadFile(s.choicePath)
		choice, _, _ := bytes.Cut(raw, []byte{'\n'})
		if string(choice) != "edge" {
			return fmt.Errorf("edge is not selected")
		}
	}
	return nil
}

func runSelected(ctx context.Context, selection backendSelection) error {
	ticker := time.NewTicker(backendCheckInterval)
	defer ticker.Stop()
	var idle bool
	for ctx.Err() == nil {
		if err := selection.check(); err != nil {
			if !idle {
				log.Printf("edge idle: %v", err)
				idle = true
			}
		} else {
			err, blocked := runWhileSelected(ctx, selection, ticker.C)
			if ctx.Err() != nil {
				return nil
			}
			if blocked != nil {
				log.Printf("edge idle: %v", blocked)
				idle = true
			} else {
				return err
			}
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
	return nil
}

func runWhileSelected(parent context.Context, selection backendSelection, checks <-chan time.Time) (err, blocked error) {
	ctx, cancel := context.WithCancelCause(parent)
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := selection.check(); err != nil {
			cancel(err)
			return err
		}
		return ctx.Err()
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() {
			if p := recover(); p != nil {
				err := fmt.Errorf("process monitor panic: %v", p)
				log.Print(err)
				cancel(err)
			}
		}()
		for {
			select {
			case <-ctx.Done():
				return
			case <-checks:
				if check() != nil {
					return
				}
			}
		}
	}()
	err = runActive(ctx, check)
	blocked = context.Cause(ctx)
	cancel(nil)
	<-done
	return err, blocked
}

func closeOnCancellation(ctx context.Context, name string, closeResource func() error) func() {
	done := make(chan struct{})
	closeAndSignal := func() {
		defer close(done)
		defer func() {
			if p := recover(); p != nil {
				log.Printf("close %s panic: %v", name, p)
			}
		}()
		if err := closeResource(); err != nil {
			log.Printf("close %s: %v", name, err)
		}
	}
	stop := context.AfterFunc(ctx, closeAndSignal)
	return func() {
		if stop() {
			closeAndSignal()
		}
		<-done
	}
}
