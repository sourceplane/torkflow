package cli

import (
	"fmt"
	"os"
	"strings"
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
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Commands:")
	fmt.Fprintln(out, "  run   Execute a workflow")
	fmt.Fprintln(out, "  view  Inspect workflow metadata and DAG")
}
