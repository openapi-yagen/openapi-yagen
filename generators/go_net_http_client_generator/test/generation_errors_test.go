package clienttest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Shells out to the openapi-yagen binary directly (not through generate.sh, which regenerates the
// *happy-path* kitchensink.yaml fixture under default strict=true) to prove an unsupported query
// parameter array serialization style actually fails generation loudly instead of silently
// emitting the wrong wire format - see resources/unsupported_query_array_style.yaml and
// operations.js's buildArrayQueryParam.

func openApiYagenBinary() string {
	if bin := os.Getenv("OPENAPI_YAGEN"); bin != "" {
		return bin
	}
	return "../../../dist/openapi-yagen"
}

func generateQueryArrayStyleFixture(t *testing.T, outDir string, extraArgs ...string) (string, error) {
	t.Helper()
	args := []string{
		"g", "-o", outDir,
		"-g", "../src",
		"resources/unsupported_query_array_style.yaml",
		"-v", "packageName=go_net_http_client_generator_test/unsupported",
	}
	args = append(args, extraArgs...)
	cmd := exec.Command(openApiYagenBinary(), args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestUnsupportedQueryArrayStyleAbortsGenerationByDefault(t *testing.T) {
	outDir := t.TempDir()
	output, err := generateQueryArrayStyleFixture(t, outDir)
	if err == nil {
		t.Fatalf("expected generation to fail in strict mode (default), output:\n%s", output)
	}
	if !strings.Contains(output, "matrix") {
		t.Fatalf("expected error output to mention the unsupported style, got:\n%s", output)
	}
}

func TestUnsupportedQueryArrayStyleIsSkippedWithAWarningUnderStrictFalse(t *testing.T) {
	outDir := t.TempDir()
	output, err := generateQueryArrayStyleFixture(t, outDir, "-v", "strict=false")
	if err != nil {
		t.Fatalf("expected generation to succeed under -v strict=false, output:\n%s", output)
	}
	if !strings.Contains(output, "WARNING") || !strings.Contains(output, "matrix") {
		t.Fatalf("expected a WARNING mentioning the unsupported style, got:\n%s", output)
	}
	if _, err := os.Stat(filepath.Join(outDir, "client", "NotesClient.go")); !os.IsNotExist(err) {
		t.Fatalf("the only operation on the only tag was skipped, so no client file should exist for it (stat err: %v)", err)
	}
}
