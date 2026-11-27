package servertest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtensibleEnumIsGeneratedAsOpenEnum(t *testing.T) {
	binary := os.Getenv("OPENAPI_YAGEN")
	if binary == "" {
		binary = "../../../dist/openapi-yagen"
	}
	outDir := t.TempDir()
	output, err := exec.Command(binary, "g", "-o", outDir, "-g", "../src", "resources/extensible_enum.yaml",
		"-v", "packageName=example.com/extensible").CombinedOutput()
	if err != nil {
		t.Fatalf("generation failed: %v\n%s", err, output)
	}
	model, err := os.ReadFile(filepath.Join(outDir, "models", "Priority.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`PriorityLow Priority = "low"`, "func (v Priority) IsKnown() bool"} {
		if !strings.Contains(string(model), expected) {
			t.Errorf("expected %q in:\n%s", expected, model)
		}
	}
}
