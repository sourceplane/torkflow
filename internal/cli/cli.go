package cli

import (
	"fmt"
	"os"
	"strings"

	"torkflow/internal/backend"
)

func Execute(args []string) int {
	if len(args) == 0 {
		printRootUsage(os.Stderr)
		return 2
	}

	switch args[0] {
	case "run":
		return runCommand(args[1:])
	case "view":
		return viewCommand(args[1:])
	case "backend":
		// contract/v1: read a Request on stdin, write a Response on stdout.
		// The embedding caller (orun) injects connections; no files are read
		// for credentials. See internal/backend/contract/v1/.
		//
		// stdout belongs to the contract: capture the real stdout for the
		// response, then point the process's os.Stdout at stderr so engine and
		// core-action prints (core.stdout banners) cannot corrupt the response
		// stream. Done here, while the process is still single-threaded — a
		// swap inside the run would race with the scheduler's workers.
		realStdout := os.Stdout
		os.Stdout = os.Stderr
		return backend.Run(os.Stdin, realStdout)
	case "help", "-h", "--help":
		printRootUsage(os.Stdout)
		return 0
	default:
		// Backward compatibility for old flag-only mode.
		if strings.HasPrefix(args[0], "-") {
			return runCommand(args)
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", args[0])
		printRootUsage(os.Stderr)
		return 2
	}
}

func printRootUsage(out *os.File) {
	fmt.Fprintln(out, "Usage:")
	fmt.Fprintln(out, "  torkflow run [flags]")
	fmt.Fprintln(out, "  torkflow view --workflow <file>")
	fmt.Fprintln(out, "  torkflow backend   (contract/v1 on stdin/stdout)")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Commands:")
	fmt.Fprintln(out, "  run      Execute a workflow")
	fmt.Fprintln(out, "  view     Inspect workflow metadata and DAG")
	fmt.Fprintln(out, "  backend  Run one workflow over the contract/v1 wire protocol (for embedding callers like orun)")
}
