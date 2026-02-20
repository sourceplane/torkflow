package expression

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/dop251/goja"
)

var templateRe = regexp.MustCompile(`\{\{\s*(.+?)\s*\}\}`)

func ResolveString(input string, context map[string]any) (string, error) {
	matches := templateRe.FindAllStringSubmatchIndex(input, -1)
	if len(matches) == 0 {
		return input, nil
	}

	builder := strings.Builder{}
	lastIndex := 0
	for _, match := range matches {
		start, end := match[0], match[1]
		exprStart, exprEnd := match[2], match[3]
		builder.WriteString(input[lastIndex:start])
		expr := input[exprStart:exprEnd]
		value, err := Eval(expr, context)
		if err != nil {
			return "", err
		}
		builder.WriteString(fmt.Sprintf("%v", value))
		lastIndex = end
	}
	builder.WriteString(input[lastIndex:])
	return builder.String(), nil
}

func Eval(expr string, context map[string]any) (any, error) {
	vm := newVM(context)
	value, err := vm.RunString(expr)
	if err != nil {
		return nil, err
	}
	return value.Export(), nil
}

func EvalScript(script string, context map[string]any) (any, error) {
	vm := newVM(context)
	value, err := vm.RunString(script)
	if err == nil {
		return value.Export(), nil
	}

	wrapped := "(function(){\n" + script + "\n})()"
	wrappedVM := newVM(context)
	wrappedValue, wrappedErr := wrappedVM.RunString(wrapped)
	if wrappedErr == nil {
		return wrappedValue.Export(), nil
	}

	return nil, err
}

func newVM(context map[string]any) *goja.Runtime {
	vm := goja.New()
	vm.Set("$", context)
	vm.Set("Steps", context["Steps"])
	vm.Set("Trigger", context["Trigger"])
	return vm
}
