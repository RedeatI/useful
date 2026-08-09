package publishers

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
)

type archiveTestEntry struct {
	name   string
	data   []byte
	method uint16
}

func makeArchiveForBudgetTest(t *testing.T, entries ...archiveTestEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, entry := range entries {
		h := &zip.FileHeader{Name: entry.name, Method: entry.method}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func openArchiveForBudgetTest(t *testing.T, raw []byte) *zip.Reader {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return zr
}

func preflightContainerBytes(t *testing.T, ctx context.Context, raw []byte) error {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "container-*.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(raw); err != nil {
		t.Fatal(err)
	}
	return preflightZIPContainer(ctx, f, int64(len(raw)))
}

func TestZIPContainerPreflightBoundsEOCDAndCentralDirectory(t *testing.T) {
	valid := makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: []byte(`{}`), method: zip.Store},
	)
	if err := preflightContainerBytes(t, context.Background(), valid); err != nil {
		t.Fatalf("valid EOCD must pass bounded container preflight: %v", err)
	}
	eocd := bytes.LastIndex(valid, []byte{'P', 'K', 5, 6})
	if eocd < 0 {
		t.Fatal("fixture EOCD missing")
	}

	tooMany := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint16(tooMany[eocd+8:eocd+10], uint16(maxArchiveEntries+1))
	binary.LittleEndian.PutUint16(tooMany[eocd+10:eocd+12], uint16(maxArchiveEntries+1))
	if err := preflightContainerBytes(t, context.Background(), tooMany); err == nil {
		t.Fatal("EOCD entry count over budget must fail before zip.NewReader")
	}

	centralTooLarge := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(centralTooLarge[eocd+12:eocd+16], uint32(maxCentralDirectoryBytes+1))
	if err := preflightContainerBytes(t, context.Background(), centralTooLarge); err == nil {
		t.Fatal("central directory byte budget must fail before zip.NewReader")
	}

	missingZIP64 := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint16(missingZIP64[eocd+10:eocd+12], math.MaxUint16)
	if err := preflightContainerBytes(t, context.Background(), missingZIP64); err == nil {
		t.Fatal("ZIP64 sentinel without bounded locator/EOCD must fail")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := preflightContainerBytes(t, ctx, valid); !errors.Is(err, context.Canceled) {
		t.Fatalf("container preflight must honor cancellation: %v", err)
	}
}

func fakeZipFile(name string, expanded, compressed uint64) *zip.File {
	f := &zip.File{FileHeader: zip.FileHeader{Name: name}}
	f.UncompressedSize64 = expanded
	f.CompressedSize64 = compressed
	return f
}

func TestArchiveManifestExactLimitAndLimitPlusOne(t *testing.T) {
	base := []byte(`{"schemaVersion":1,"id":"com.test.limit","name":"Limit","version":"1.0.0","permissions":[],"entry":{"type":"web","path":"index.html"}}`)
	exact := append(base, bytes.Repeat([]byte(" "), int(maxManifestBytes)-len(base))...)
	zr := openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: exact, method: zip.Store},
		archiveTestEntry{name: "index.html", data: []byte("ok"), method: zip.Store},
	))
	if err := preflightArchive(zr); err != nil {
		t.Fatalf("exact manifest limit preflight should pass: %v", err)
	}
	contents, err := readArchiveContents(context.Background(), zr)
	if err != nil || len(contents.manifest) != int(maxManifestBytes) {
		t.Fatalf("exact manifest limit should be fully read: len=%d err=%v", len(contents.manifest), err)
	}

	over := append(append([]byte(nil), exact...), 'x')
	zr = openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: over, method: zip.Store},
	))
	if err := preflightArchive(zr); err == nil {
		t.Fatal("manifest limit+1 must fail in central-directory preflight")
	}
	if _, err := readArchiveContents(context.Background(), zr); err == nil {
		t.Fatal("manifest limit+1 must fail instead of hashing a truncated prefix")
	}
}

func TestArchivePreflightAggregateRatioNativeAndOverflowBudgets(t *testing.T) {
	tooMany := make([]*zip.File, maxArchiveEntries+1)
	for i := range tooMany {
		tooMany[i] = fakeZipFile(fmt.Sprintf("entry-%05d.bin", i), 0, 0)
	}
	if err := preflightArchive(&zip.Reader{File: tooMany}); err == nil {
		t.Fatal("entry count limit+1 must fail")
	}

	if err := preflightArchive(&zip.Reader{File: []*zip.File{
		fakeZipFile("entry.bin", maxArchiveEntryBytes, maxArchiveEntryBytes),
	}}); err != nil {
		t.Fatalf("single-entry expanded exact limit should pass: %v", err)
	}
	if err := preflightArchive(&zip.Reader{File: []*zip.File{
		fakeZipFile("entry.bin", maxArchiveEntryBytes+1, maxArchiveEntryBytes+1),
	}}); err == nil {
		t.Fatal("single-entry expanded limit+1 must fail")
	}

	if err := preflightArchive(&zip.Reader{File: []*zip.File{
		fakeZipFile("a.bin", maxArchiveEntryBytes, maxArchiveEntryBytes),
		fakeZipFile("b.bin", maxArchiveEntryBytes, maxArchiveEntryBytes),
	}}); err != nil {
		t.Fatalf("expanded aggregate exact 1 GiB limit should pass: %v", err)
	}
	zr := &zip.Reader{File: []*zip.File{
		fakeZipFile("a.bin", maxArchiveEntryBytes, maxArchiveEntryBytes),
		fakeZipFile("b.bin", maxArchiveEntryBytes, maxArchiveEntryBytes),
		fakeZipFile("overflow.bin", 1, 1),
	}}
	if err := preflightArchive(zr); err == nil {
		t.Fatal("multi-entry expanded aggregate limit+1 must fail")
	}

	if err := preflightArchive(&zip.Reader{File: []*zip.File{
		fakeZipFile("ratio.bin", maxArchiveCompressionRatio, 1),
	}}); err != nil {
		t.Fatalf("compression ratio exact limit should pass: %v", err)
	}
	zr = &zip.Reader{File: []*zip.File{fakeZipFile("ratio.bin", maxArchiveCompressionRatio+1, 1)}}
	if err := preflightArchive(zr); err == nil {
		t.Fatal("compression ratio limit+1 must fail")
	}

	zr = &zip.Reader{File: []*zip.File{
		fakeZipFile("a.exe", 400<<20, 400<<20),
		fakeZipFile("b.dll", 400<<20, 400<<20),
		fakeZipFile("c.so", 400<<20, 400<<20),
	}}
	if err := preflightArchive(zr); err == nil {
		t.Fatal("native aggregate hash budget must fail")
	}
	nativeFiles := make([]*zip.File, maxNativeEntries+1)
	for i := range nativeFiles {
		nativeFiles[i] = fakeZipFile(fmt.Sprintf("payload/tool-%03d.exe", i), 0, 0)
	}
	if err := preflightArchive(&zip.Reader{File: nativeFiles}); err == nil {
		t.Fatal("native entry count limit+1 must fail")
	}

	total := uint64(math.MaxUint64 - 2)
	if err := addBudget(&total, 3, math.MaxUint64, "test"); err == nil {
		t.Fatal("u64 budget addition overflow must fail closed")
	}
}

func TestArchiveNativeHashRequiresEOFAndCRC(t *testing.T) {
	raw := makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: []byte(`{"schemaVersion":1,"id":"com.test.crc","name":"CRC","version":"1.0.0","permissions":[],"entry":{"type":"worker","path":"payload/tool.exe"}}`), method: zip.Store},
		archiveTestEntry{name: "payload/tool.exe", data: []byte("MZ native payload that must be checksummed"), method: zip.Store},
	)
	needle := []byte("MZ native payload that must be checksummed")
	offset := bytes.Index(raw, needle)
	if offset < 0 {
		t.Fatal("test archive payload not found")
	}
	raw[offset+3] ^= 0xff
	zr := openArchiveForBudgetTest(t, raw)
	if err := preflightArchive(zr); err != nil {
		t.Fatalf("central-directory preflight should not mask CRC test: %v", err)
	}
	if _, err := readArchiveContents(context.Background(), zr); err == nil {
		t.Fatal("corrupt native entry must fail; a truncated/unchecked hash is not success")
	}
}

func TestArchiveLedgerRejectsADSCaseDuplicatesAndLinks(t *testing.T) {
	for name, entries := range map[string][]archiveTestEntry{
		"ads": {
			{name: "manifest.json", data: []byte(`{}`), method: zip.Store},
			{name: "payload/tool.exe:Zone.Identifier", data: []byte("ads"), method: zip.Store},
		},
		"case-folded duplicate": {
			{name: "manifest.json", data: []byte(`{}`), method: zip.Store},
			{name: "Payload/Tool.bin", data: []byte("a"), method: zip.Store},
			{name: "payload/tool.bin", data: []byte("b"), method: zip.Store},
		},
	} {
		t.Run(name, func(t *testing.T) {
			zr := openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t, entries...))
			if err := preflightArchive(zr); err == nil {
				t.Fatal("unsafe archive ledger must fail closed")
			}
		})
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	h := &zip.FileHeader{Name: "payload/link", Method: zip.Store}
	// SetMode accepts one Unix file type. Mixing ModeDir and ModeSymlink does
	// not encode a symlink in a ZIP header, so use a real symlink entry here.
	h.SetMode(os.ModeSymlink | 0o777)
	w, err := zw.CreateHeader(h)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("target"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := preflightArchive(openArchiveForBudgetTest(t, buf.Bytes())); err == nil {
		t.Fatal("symlink entry must fail closed")
	}
}

func TestArchiveWorkerPathIsUniqueAndAlwaysNativeHashed(t *testing.T) {
	manifest := []byte(`{"schemaVersion":1,"id":"com.test.worker","name":"Worker","version":"1.0.0","permissions":[],"entry":{"type":"worker","path":"payload/worker"}}`)
	zr := openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: manifest, method: zip.Store},
		archiveTestEntry{name: "payload/worker", data: []byte("native without extension"), method: zip.Store},
	))
	contents, err := readArchiveContents(context.Background(), zr)
	if err != nil {
		t.Fatal(err)
	}
	if !contents.isNativeWorker || len(contents.executableHashes) != 1 ||
		!strings.HasPrefix(contents.executableHashes[0], "payload/worker=") {
		t.Fatalf("worker entry.path must count toward native hash ledger: %#v", contents.executableHashes)
	}

	zr = openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: manifest, method: zip.Store},
	))
	if _, err := readArchiveContents(context.Background(), zr); err == nil {
		t.Fatal("missing worker entry.path must fail closed")
	}
}

func TestArchiveManifestRejectsUnknownFields(t *testing.T) {
	zr := openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: []byte(`{"schemaVersion":1,"id":"com.test.unknown","name":"Unknown","version":"1.0.0","permissions":[],"entry":{"type":"web","path":"index.html"},"unexpected":true}`), method: zip.Store},
	))
	if _, err := readArchiveContents(context.Background(), zr); err == nil {
		t.Fatal("unknown manifest field must fail closed")
	}
}

func TestManifestRejectsClientRejectedVectors(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		extra    []archiveTestEntry
	}{
		{
			name:     "null permissions",
			manifest: `{"schemaVersion":1,"id":"com.test.null","name":"Null","version":"1.0.0","permissions":null,"entry":{"type":"web","path":"index.html"}}`,
		},
		{
			name:     "reserved builtin namespace",
			manifest: `{"schemaVersion":1,"id":"builtin.test","name":"Builtin","version":"1.0.0","permissions":[],"entry":{"type":"web","path":"index.html"}}`,
		},
		{
			name:     "control character name",
			manifest: `{"schemaVersion":1,"id":"com.test.control","name":"bad\u0001name","version":"1.0.0","permissions":[],"entry":{"type":"web","path":"index.html"}}`,
		},
		{
			name:     "null entry args",
			manifest: `{"schemaVersion":1,"id":"com.test.args","name":"Args","version":"1.0.0","permissions":[],"entry":{"type":"web","path":"index.html","args":null}}`,
		},
		{
			name:     "unsafe icon path",
			manifest: `{"schemaVersion":1,"id":"com.test.icon","name":"Icon","version":"1.0.0","icon":"../icon.png","permissions":[],"entry":{"type":"web","path":"index.html"}}`,
		},
		{
			name:     "unsupported platform",
			manifest: `{"schemaVersion":1,"id":"com.test.platform","name":"Platform","version":"1.0.0","platforms":["linux-x64"],"permissions":[],"entry":{"type":"web","path":"index.html"}}`,
		},
		{
			name:     "action outside namespace",
			manifest: `{"schemaVersion":1,"id":"com.test.actions","name":"Actions","version":"1.0.0","permissions":[],"entry":{"type":"web","path":"index.html"},"contributes":{"actions":[{"actionId":"other.action","path":"actions/a.json"}]}}`,
			extra:    []archiveTestEntry{{name: "actions/a.json", data: []byte(`{}`), method: zip.Store}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			entries := []archiveTestEntry{
				{name: "manifest.json", data: []byte(tc.manifest), method: zip.Store},
				{name: "index.html", data: []byte("ok"), method: zip.Store},
			}
			entries = append(entries, tc.extra...)
			zr := openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t, entries...))
			if _, err := readArchiveContents(context.Background(), zr); err == nil {
				t.Fatal("server must reject a manifest vector already rejected by current clients")
			}
		})
	}
}

func TestManifestCurrentClosedContractAccepted(t *testing.T) {
	manifest := []byte(`{"schemaVersion":1,"id":"com.test.full","name":"Full","version":"1.0.0","description":"full contract","icon":"assets/icon.png","entry":{"type":"web","path":"index.html","args":[]},"contributes":{"sidebar":[{"id":"main","title":"Main","group":"installed","order":1}],"actions":[{"actionId":"com.test.full.encode","path":"actions/encode.json"}]},"permissions":[],"platforms":["windows-x64"],"minHostVersion":"0.1.0"}`)
	zr := openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: manifest, method: zip.Store},
		archiveTestEntry{name: "index.html", data: []byte("ok"), method: zip.Store},
		archiveTestEntry{name: "assets/icon.png", data: []byte("png"), method: zip.Store},
		archiveTestEntry{name: "actions/encode.json", data: []byte(`{}`), method: zip.Store},
	))
	if _, err := readArchiveContents(context.Background(), zr); err != nil {
		t.Fatalf("current closed manifest contract should pass: %v", err)
	}
}

func TestArchiveManifestEntryPermissionContract(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		wantErr  bool
	}{
		{
			name:     "web native permission",
			manifest: `{"schemaVersion":1,"id":"com.test.web","name":"Web","version":"1.0.0","permissions":["process.launch.declared"],"entry":{"type":"web","path":"index.html"}}`,
			wantErr:  true,
		},
		{
			name:     "launcher missing permission",
			manifest: `{"schemaVersion":1,"id":"com.test.launcher","name":"Launcher","version":"1.0.0","permissions":[],"entry":{"type":"launcher","path":"https://example.invalid"}}`,
			wantErr:  true,
		},
		{
			name:     "launcher declared permission",
			manifest: `{"schemaVersion":1,"id":"com.test.launcher","name":"Launcher","version":"1.0.0","permissions":["process.launch.declared"],"entry":{"type":"launcher","path":"https://example.invalid"}}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			zr := openArchiveForBudgetTest(t, makeArchiveForBudgetTest(t,
				archiveTestEntry{name: "manifest.json", data: []byte(tc.manifest), method: zip.Store},
			))
			_, err := readArchiveContents(context.Background(), zr)
			if (err != nil) != tc.wantErr {
				t.Fatalf("permission contract error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestArchiveReadHonorsCancellation(t *testing.T) {
	raw := makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: []byte(`{"entry":{"type":"web"}}`), method: zip.Store},
	)
	zr := openArchiveForBudgetTest(t, raw)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := readArchiveContents(ctx, zr)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled archive read must fail with context.Canceled, got %v", err)
	}
}
