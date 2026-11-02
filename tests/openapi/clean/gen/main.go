// Command gen is the fixture generator: it writes generated.txt (the operation count of openapi.yaml).
package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	spec, err := os.ReadFile("openapi.yaml")
	if err != nil {
		panic(err)
	}
	out := fmt.Sprintf("operations: %d\n", strings.Count(string(spec), "operationId:"))
	if err := os.WriteFile("generated.txt", []byte(out), 0o644); err != nil {
		panic(err)
	}
}
