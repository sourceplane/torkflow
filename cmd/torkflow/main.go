package main

import (
	"os"

	"torkflow/internal/cli"
)

func main() {
	os.Exit(cli.Execute(os.Args[1:]))
}
