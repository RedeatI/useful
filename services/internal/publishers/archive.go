package publishers

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"regexp"
	"strings"
	"time"

	"useful.dev/source/internal/domain"
)

const (
	maxArchiveEntries          = 10_000
	maxArchiveEntryBytes       = uint64(512 << 20)
	maxArchiveExpandedBytes    = uint64(1 << 30)
	maxArchiveCompressionRatio = uint64(1000)
	maxManifestBytes           = uint64(256 << 10)
	maxNativeEntries           = 256
	maxNativeHashBytes         = uint64(1 << 30)
	maxCentralDirectoryBytes   = uint64(64 << 20)
	maxZIP64EOCDRecordBytes    = uint64(1 << 20)
	defaultArchiveReadTimeout  = 2 * time.Minute
)

const (
	zipEOCDSignature      = 0x06054b50
	zip64EOCDSignature    = 0x06064b50
	zip64LocatorSignature = 0x07064b50
	zipEOCDMinBytes       = 22
	zipMaxCommentBytes    = 1<<16 - 1
	zipEOCDSearchBytes    = zipEOCDMinBytes + zipMaxCommentBytes
)

var (
	manifestIDRe = regexp.MustCompile(`^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$`)
	actionIDRe   = regexp.MustCompile(`^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$`)
)

type archiveContents struct {
	manifest         []byte
	parsedManifest   packageManifest
	executableHashes []string
	hasSBOM          bool
	isNativeWorker   bool
}

type packageManifest struct {
	SchemaVersion  int                `json:"schemaVersion"`
	ID             string             `json:"id"`
	Name           string             `json:"name"`
	Version        string             `json:"version"`
	Description    string             `json:"description"`
	Icon           *string            `json:"icon"`
	Entry          packageEntry       `json:"entry"`
	Contributes    packageContributes `json:"contributes"`
	Permissions    []string           `json:"permissions"`
	Platforms      []string           `json:"platforms"`
	MinHostVersion string             `json:"minHostVersion"`
}

type packageEntry struct {
	Type string   `json:"type"`
	Path string   `json:"path"`
	Args []string `json:"args"`
}

type packageContributes struct {
	Sidebar []packageSidebar `json:"sidebar"`
	Actions []packageAction  `json:"actions"`
}

type packageSidebar struct {
	ID    string  `json:"id"`
	Title string  `json:"title"`
	Group *string `json:"group"`
	Order *int    `json:"order"`
}

type packageAction struct {
	ActionID string `json:"actionId"`
	Path     string `json:"path"`
}

type archiveLedger struct {
	byPath     map[string]*zip.File
	pathByFile map[*zip.File]string
	native     map[string]bool
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.r.Read(p)
	if err == nil {
		if ctxErr := r.ctx.Err(); ctxErr != nil {
			return n, ctxErr
		}
	}
	return n, err
}

func readArchiveAt(ctx context.Context, f *os.File, dst []byte, offset int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	n, err := f.ReadAt(dst, offset)
	if err != nil && err != io.EOF {
		return err
	}
	if n != len(dst) {
		return io.ErrUnexpectedEOF
	}
	return ctx.Err()
}

func checkedEnd(offset, size uint64) (uint64, bool) {
	if size > math.MaxUint64-offset {
		return 0, false
	}
	return offset + size, true
}

// preflightZIPContainer parses only a bounded EOCD/ZIP64 tail before archive/zip
// is allowed to allocate or walk the central directory.
func preflightZIPContainer(ctx context.Context, f *os.File, fileSize int64) error {
	if fileSize < zipEOCDMinBytes {
		return fmt.Errorf("ZIP EOCD 缺失")
	}
	tailSize := int64(zipEOCDSearchBytes)
	if fileSize < tailSize {
		tailSize = fileSize
	}
	tail := make([]byte, int(tailSize))
	if err := readArchiveAt(ctx, f, tail, fileSize-tailSize); err != nil {
		return err
	}
	eocdIndex := -1
	for i := len(tail) - zipEOCDMinBytes; i >= 0; i-- {
		if binary.LittleEndian.Uint32(tail[i:i+4]) != zipEOCDSignature {
			continue
		}
		commentBytes := int(binary.LittleEndian.Uint16(tail[i+20 : i+22]))
		if i+zipEOCDMinBytes+commentBytes == len(tail) {
			eocdIndex = i
			break
		}
	}
	if eocdIndex < 0 {
		return fmt.Errorf("ZIP EOCD 非法或 comment 未闭合")
	}
	eocd := tail[eocdIndex : eocdIndex+zipEOCDMinBytes]
	eocdOffset := uint64(fileSize-tailSize) + uint64(eocdIndex)
	disk := binary.LittleEndian.Uint16(eocd[4:6])
	centralDisk := binary.LittleEndian.Uint16(eocd[6:8])
	entriesOnDisk16 := binary.LittleEndian.Uint16(eocd[8:10])
	entries16 := binary.LittleEndian.Uint16(eocd[10:12])
	centralBytes32 := binary.LittleEndian.Uint32(eocd[12:16])
	centralOffset32 := binary.LittleEndian.Uint32(eocd[16:20])
	if disk != 0 || centralDisk != 0 {
		return fmt.Errorf("不支持多磁盘 ZIP")
	}

	entries := uint64(entries16)
	entriesOnDisk := uint64(entriesOnDisk16)
	centralBytes := uint64(centralBytes32)
	centralOffset := uint64(centralOffset32)
	centralBoundary := eocdOffset
	usesZIP64 := entriesOnDisk16 == math.MaxUint16 || entries16 == math.MaxUint16 ||
		centralBytes32 == math.MaxUint32 || centralOffset32 == math.MaxUint32
	if usesZIP64 {
		if eocdOffset < 20 {
			return fmt.Errorf("ZIP64 locator 缺失")
		}
		locatorOffset := eocdOffset - 20
		locator := make([]byte, 20)
		if err := readArchiveAt(ctx, f, locator, int64(locatorOffset)); err != nil {
			return err
		}
		if binary.LittleEndian.Uint32(locator[0:4]) != zip64LocatorSignature ||
			binary.LittleEndian.Uint32(locator[4:8]) != 0 ||
			binary.LittleEndian.Uint32(locator[16:20]) != 1 {
			return fmt.Errorf("ZIP64 locator 非法或为多磁盘")
		}
		zip64Offset := binary.LittleEndian.Uint64(locator[8:16])
		if zip64Offset > math.MaxInt64 || zip64Offset >= locatorOffset {
			return fmt.Errorf("ZIP64 EOCD offset 非法")
		}
		zip64 := make([]byte, 56)
		if err := readArchiveAt(ctx, f, zip64, int64(zip64Offset)); err != nil {
			return err
		}
		recordBytes := binary.LittleEndian.Uint64(zip64[4:12])
		if binary.LittleEndian.Uint32(zip64[0:4]) != zip64EOCDSignature ||
			recordBytes < 44 || recordBytes > maxZIP64EOCDRecordBytes {
			return fmt.Errorf("ZIP64 EOCD 大小非法")
		}
		recordEnd, ok := checkedEnd(zip64Offset, 12+recordBytes)
		if !ok || recordEnd != locatorOffset ||
			binary.LittleEndian.Uint32(zip64[16:20]) != 0 ||
			binary.LittleEndian.Uint32(zip64[20:24]) != 0 {
			return fmt.Errorf("ZIP64 EOCD 边界非法或为多磁盘")
		}
		entriesOnDisk = binary.LittleEndian.Uint64(zip64[24:32])
		entries = binary.LittleEndian.Uint64(zip64[32:40])
		centralBytes = binary.LittleEndian.Uint64(zip64[40:48])
		centralOffset = binary.LittleEndian.Uint64(zip64[48:56])
		centralBoundary = zip64Offset
	}
	if entriesOnDisk != entries || entries > maxArchiveEntries {
		return fmt.Errorf("ZIP central directory entry 数量非法或超限")
	}
	if centralBytes > maxCentralDirectoryBytes {
		return fmt.Errorf("ZIP central directory 大小超限")
	}
	centralEnd, ok := checkedEnd(centralOffset, centralBytes)
	if !ok || centralEnd > centralBoundary || centralEnd > uint64(fileSize) {
		return fmt.Errorf("ZIP central directory offset/大小非法")
	}
	return ctx.Err()
}

func isNativeArchiveEntry(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasSuffix(lower, ".exe") || strings.HasSuffix(lower, ".dll") ||
		strings.HasSuffix(lower, ".so") || strings.HasSuffix(lower, ".dylib")
}

func validateArchivePath(name string) error {
	if name == "" || strings.ContainsRune(name, 0) || strings.Contains(name, "\\") || strings.Contains(name, ":") ||
		strings.HasPrefix(name, "/") || (len(name) > 1 && name[1] == ':') {
		return fmt.Errorf("包内路径不安全: %q", name)
	}
	cleanInput := strings.TrimSuffix(name, "/")
	if cleanInput == "" || path.Clean(cleanInput) != cleanInput {
		return fmt.Errorf("包内路径不安全: %q", name)
	}
	for _, component := range strings.Split(cleanInput, "/") {
		if component == ".." || component == "." || component == "" {
			return fmt.Errorf("包内路径不安全: %q", name)
		}
	}
	return nil
}

func normalizedArchivePath(name string) string {
	return strings.ToLower(strings.TrimSuffix(name, "/"))
}

func addBudget(total *uint64, amount, limit uint64, label string) error {
	if amount > math.MaxUint64-*total {
		return fmt.Errorf("%s 计数溢出", label)
	}
	*total += amount
	if *total > limit {
		return fmt.Errorf("%s 超限", label)
	}
	return nil
}

func compressionRatioExceeded(expanded, compressed uint64) bool {
	if expanded == 0 {
		return false
	}
	if compressed == 0 {
		return true
	}
	if compressed > math.MaxUint64/maxArchiveCompressionRatio {
		return false
	}
	return expanded > compressed*maxArchiveCompressionRatio
}

func enforceNativeLedgerBudget(ledger *archiveLedger) error {
	var nativeTotal uint64
	nativeCount := 0
	for normalized := range ledger.native {
		f := ledger.byPath[normalized]
		if f == nil || f.FileInfo().IsDir() {
			return fmt.Errorf("原生 entry 不存在或不是文件")
		}
		nativeCount++
		if nativeCount > maxNativeEntries {
			return fmt.Errorf("原生文件数量超限")
		}
		if err := addBudget(&nativeTotal, f.UncompressedSize64, maxNativeHashBytes, "原生文件哈希总大小"); err != nil {
			return err
		}
	}
	return nil
}

func buildArchiveLedger(zr *zip.Reader) (*archiveLedger, error) {
	if len(zr.File) > maxArchiveEntries {
		return nil, fmt.Errorf("文件数量超限")
	}
	ledger := &archiveLedger{
		byPath: map[string]*zip.File{}, pathByFile: map[*zip.File]string{}, native: map[string]bool{},
	}
	var expandedTotal, compressedTotal uint64
	for _, f := range zr.File {
		if err := validateArchivePath(f.Name); err != nil {
			return nil, err
		}
		normalized := normalizedArchivePath(f.Name)
		if _, exists := ledger.byPath[normalized]; exists {
			return nil, fmt.Errorf("包内 entry 重复: %q", f.Name)
		}
		ledger.byPath[normalized] = f
		ledger.pathByFile[f] = normalized
		mode := f.Mode()
		modeType := mode & os.ModeType
		// Reject link/special types before considering the directory fast-path.
		// A trailing slash or directory bit must never mask an independently
		// declared non-directory type.
		if modeType&os.ModeSymlink != 0 || (modeType != 0 && modeType != os.ModeDir) {
			return nil, fmt.Errorf("包内不允许链接或特殊文件: %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if modeType != os.ModeDir {
				return nil, fmt.Errorf("目录 entry 类型标记不一致: %q", f.Name)
			}
			if f.UncompressedSize64 != 0 {
				return nil, fmt.Errorf("目录 entry 不得携带数据: %q", f.Name)
			}
			continue
		}
		if modeType != 0 || !mode.IsRegular() {
			return nil, fmt.Errorf("包内不允许链接或特殊文件: %q", f.Name)
		}
		if f.UncompressedSize64 > maxArchiveEntryBytes {
			return nil, fmt.Errorf("单文件解压大小超限: %q", f.Name)
		}
		if f.Name == "manifest.json" && f.UncompressedSize64 > maxManifestBytes {
			return nil, fmt.Errorf("manifest.json 大小超限")
		}
		if err := addBudget(&expandedTotal, f.UncompressedSize64, maxArchiveExpandedBytes, "包解压总大小"); err != nil {
			return nil, err
		}
		if err := addBudget(&compressedTotal, f.CompressedSize64, math.MaxUint64, "包压缩总大小"); err != nil {
			return nil, err
		}
		if compressionRatioExceeded(f.UncompressedSize64, f.CompressedSize64) {
			return nil, fmt.Errorf("压缩比超限: %q", f.Name)
		}
		if isNativeArchiveEntry(f.Name) {
			ledger.native[normalized] = true
		}
	}
	if compressionRatioExceeded(expandedTotal, compressedTotal) {
		return nil, fmt.Errorf("包整体压缩比超限")
	}
	if err := enforceNativeLedgerBudget(ledger); err != nil {
		return nil, err
	}
	return ledger, nil
}

func decodePackageManifest(raw []byte) (packageManifest, error) {
	var manifest packageManifest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&manifest); err != nil {
		return packageManifest{}, err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return packageManifest{}, fmt.Errorf("manifest.json 包含多个 JSON 值")
		}
		return packageManifest{}, err
	}
	return manifest, nil
}

func rawJSONObject(raw []byte, label string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, fmt.Errorf("%s 必须是 object", label)
	}
	return object, nil
}

func rawIsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func requireRawFields(object map[string]json.RawMessage, label string, fields ...string) error {
	for _, field := range fields {
		raw, ok := object[field]
		if !ok || rawIsNull(raw) {
			return fmt.Errorf("%s 缺少字段 %s", label, field)
		}
	}
	return nil
}

func rejectPresentNull(object map[string]json.RawMessage, label string, fields ...string) error {
	for _, field := range fields {
		if raw, ok := object[field]; ok && rawIsNull(raw) {
			return fmt.Errorf("%s.%s 不得为 null", label, field)
		}
	}
	return nil
}

func validateManifestJSONShape(raw []byte) error {
	root, err := rawJSONObject(raw, "manifest")
	if err != nil {
		return err
	}
	if err := requireRawFields(root, "manifest", "schemaVersion", "id", "name", "version", "entry"); err != nil {
		return err
	}
	if err := rejectPresentNull(root, "manifest", "description", "icon", "contributes", "permissions", "platforms", "minHostVersion"); err != nil {
		return err
	}
	entry, err := rawJSONObject(root["entry"], "manifest.entry")
	if err != nil {
		return err
	}
	if err := requireRawFields(entry, "manifest.entry", "type", "path"); err != nil {
		return err
	}
	if err := rejectPresentNull(entry, "manifest.entry", "args"); err != nil {
		return err
	}
	contributesRaw, ok := root["contributes"]
	if !ok {
		return nil
	}
	contributes, err := rawJSONObject(contributesRaw, "manifest.contributes")
	if err != nil {
		return err
	}
	if err := rejectPresentNull(contributes, "manifest.contributes", "sidebar", "actions"); err != nil {
		return err
	}
	for fieldIndex, field := range []string{"sidebar", "actions"} {
		rawItems, ok := contributes[field]
		if !ok {
			continue
		}
		var items []json.RawMessage
		if err := json.Unmarshal(rawItems, &items); err != nil {
			return fmt.Errorf("manifest.contributes.%s 必须是 array", field)
		}
		for index, rawItem := range items {
			item, err := rawJSONObject(rawItem, fmt.Sprintf("manifest.contributes.%s[%d]", field, index))
			if err != nil {
				return err
			}
			if fieldIndex == 0 {
				if err := requireRawFields(item, "sidebar item", "id", "title"); err != nil {
					return err
				}
				if err := rejectPresentNull(item, "sidebar item", "group", "order"); err != nil {
					return err
				}
			} else if err := requireRawFields(item, "action item", "actionId", "path"); err != nil {
				return err
			}
		}
	}
	return nil
}

func containsManifestControl(value string, allControls bool) bool {
	for _, character := range value {
		if character == 0 || character == 127 || (allControls && character < 32) {
			return true
		}
	}
	return false
}

func exactLedgerFile(ledger *archiveLedger, name string) (*zip.File, bool) {
	file, ok := ledger.byPath[normalizedArchivePath(name)]
	return file, ok && file.Name == name && !file.FileInfo().IsDir()
}

func validatePackageManifest(manifest packageManifest, raw []byte, ledger *archiveLedger) error {
	if err := validateManifestJSONShape(raw); err != nil {
		return err
	}
	root, err := rawJSONObject(raw, "manifest")
	if err != nil {
		return err
	}
	if manifest.SchemaVersion != 1 || len(manifest.ID) > 128 || !manifestIDRe.MatchString(manifest.ID) ||
		manifest.ID == "builtin" || strings.HasPrefix(manifest.ID, "builtin.") {
		return fmt.Errorf("manifest id/schemaVersion 非法")
	}
	if manifest.Name == "" || len(manifest.Name) > 128 || containsManifestControl(manifest.Name, true) {
		return fmt.Errorf("manifest name 非法")
	}
	if !domain.IsSemver(manifest.Version) {
		return fmt.Errorf("manifest version 非法")
	}
	if len(manifest.Description) > 1024 || containsManifestControl(manifest.Description, false) {
		return fmt.Errorf("manifest description 非法")
	}
	if manifest.Entry.Path == "" || len(manifest.Entry.Path) > 1024 || strings.ContainsRune(manifest.Entry.Path, 0) {
		return fmt.Errorf("manifest entry.path 非法")
	}
	if manifest.Entry.Type != "launcher" {
		if err := validateArchivePath(manifest.Entry.Path); err != nil {
			return fmt.Errorf("manifest entry.path 非法: %w", err)
		}
		if file, ok := exactLedgerFile(ledger, manifest.Entry.Path); !ok || file.Name == "manifest.json" {
			return fmt.Errorf("manifest entry.path 必须精确指向包内文件")
		}
	}
	if manifest.Icon != nil {
		if len(*manifest.Icon) > 512 {
			return fmt.Errorf("manifest icon 路径过长")
		}
		if err := validateArchivePath(*manifest.Icon); err != nil {
			return fmt.Errorf("manifest icon 路径非法: %w", err)
		}
		if _, ok := exactLedgerFile(ledger, *manifest.Icon); !ok {
			return fmt.Errorf("manifest icon 必须精确指向包内文件")
		}
	}
	for _, platform := range manifest.Platforms {
		if platform != "windows-x64" && platform != "windows-arm64" {
			return fmt.Errorf("manifest platform 非法")
		}
	}
	_, minHostPresent := root["minHostVersion"]
	if minHostPresent && !domain.IsSemver(manifest.MinHostVersion) {
		return fmt.Errorf("manifest minHostVersion 非法")
	}
	for _, sidebar := range manifest.Contributes.Sidebar {
		if sidebar.ID == "" || sidebar.Title == "" {
			return fmt.Errorf("manifest sidebar item 非法")
		}
		if sidebar.Group != nil && *sidebar.Group != "installed" && *sidebar.Group != "builtin" {
			return fmt.Errorf("manifest sidebar group 非法")
		}
	}
	if len(manifest.Contributes.Actions) > 32 {
		return fmt.Errorf("manifest actions 数量超限")
	}
	reservedActions := map[string]bool{
		"useful.actions.search": true, "useful.actions.describe": true,
		"useful.actions.suggest": true, "useful.actions.recipe": true,
	}
	actionIDs := map[string]bool{}
	actionPaths := map[string]bool{}
	for _, action := range manifest.Contributes.Actions {
		if reservedActions[action.ActionID] || !actionIDRe.MatchString(action.ActionID) ||
			!strings.HasPrefix(action.ActionID, manifest.ID+".") || actionIDs[action.ActionID] {
			return fmt.Errorf("manifest actionId 非法、重复或越出插件命名空间")
		}
		if len(action.Path) > 1024 {
			return fmt.Errorf("manifest action path 过长")
		}
		if err := validateArchivePath(action.Path); err != nil {
			return fmt.Errorf("manifest action path 非法: %w", err)
		}
		normalized := normalizedArchivePath(action.Path)
		if actionPaths[normalized] {
			return fmt.Errorf("manifest action path 重复")
		}
		if _, ok := exactLedgerFile(ledger, action.Path); !ok {
			return fmt.Errorf("manifest action path 必须精确指向包内文件")
		}
		actionIDs[action.ActionID] = true
		actionPaths[normalized] = true
	}
	return nil
}

// preflightArchive validates all sizes and the normalized entry ledger from
// the ZIP central directory before any entry is decompressed.
func preflightArchive(zr *zip.Reader) error {
	_, err := buildArchiveLedger(zr)
	return err
}

func (s *Service) archiveContext(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := s.ArchiveReadTimeout
	if timeout <= 0 {
		timeout = defaultArchiveReadTimeout
	}
	return context.WithTimeout(ctx, timeout)
}

func (s *Service) withArchive(ctx context.Context, stagingKey, tempPrefix string, expectedSize int64, fn func(context.Context, *zip.Reader) error) error {
	ctx, cancel := s.archiveContext(ctx)
	defer cancel()
	rc, info, err := s.Store.Get(ctx, stagingKey)
	if err != nil {
		return err
	}
	defer rc.Close()
	if info.Size < 0 || info.Size == math.MaxInt64 || info.Size != expectedSize ||
		(s.MaxUpload > 0 && info.Size > s.MaxUpload) {
		return fmt.Errorf("压缩包大小非法")
	}
	tmp, err := os.CreateTemp("", tempPrefix)
	if err != nil {
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	n, err := io.Copy(tmp, io.LimitReader(&contextReader{ctx: ctx, r: rc}, info.Size+1))
	if err != nil {
		return err
	}
	if n != info.Size {
		return fmt.Errorf("压缩包存储大小不一致")
	}
	if err := preflightZIPContainer(ctx, tmp, info.Size); err != nil {
		return err
	}
	zr, err := zip.NewReader(tmp, info.Size)
	if err != nil {
		return fmt.Errorf("不是合法 ZIP: %v", err)
	}
	if err := preflightArchive(zr); err != nil {
		return err
	}
	return fn(ctx, zr)
}

func readArchiveContents(ctx context.Context, zr *zip.Reader) (*archiveContents, error) {
	contents := &archiveContents{}
	ledger, err := buildArchiveLedger(zr)
	if err != nil {
		return nil, err
	}
	manifestFile, ok := ledger.byPath["manifest.json"]
	if !ok || manifestFile.Name != "manifest.json" || manifestFile.FileInfo().IsDir() {
		return nil, fmt.Errorf("包内缺少根目录 manifest.json")
	}
	var actualExpanded, actualNative uint64
	buf := make([]byte, 64<<10)
	readEntry := func(f *zip.File, isManifest, isNative bool) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		r, err := f.Open()
		if err != nil {
			return err
		}
		var entryBytes uint64
		var h = sha256.New()
		readLimit := maxArchiveEntryBytes + 1
		if isManifest {
			// Read exactly limit+1 so an oversized manifest is distinguished from
			// one whose size is exactly the accepted 256 KiB boundary.
			readLimit = maxManifestBytes + 1
		}
		limited := io.LimitReader(&contextReader{ctx: ctx, r: r}, int64(readLimit))
		for {
			n, readErr := limited.Read(buf)
			if n > 0 {
				amount := uint64(n)
				if err := addBudget(&entryBytes, amount, maxArchiveEntryBytes, "单文件解压大小"); err != nil {
					_ = r.Close()
					return err
				}
				if err := addBudget(&actualExpanded, amount, maxArchiveExpandedBytes, "包实际解压总大小"); err != nil {
					_ = r.Close()
					return err
				}
				if isNative {
					if err := addBudget(&actualNative, amount, maxNativeHashBytes, "原生文件实际哈希总大小"); err != nil {
						_ = r.Close()
						return err
					}
					_, _ = h.Write(buf[:n])
				}
				if isManifest {
					if entryBytes > maxManifestBytes {
						_ = r.Close()
						return fmt.Errorf("manifest.json 大小超限")
					}
					contents.manifest = append(contents.manifest, buf[:n]...)
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				_ = r.Close()
				return fmt.Errorf("读取 %q 失败: %w", f.Name, readErr)
			}
		}
		if err := r.Close(); err != nil {
			return fmt.Errorf("关闭 %q 失败: %w", f.Name, err)
		}
		if entryBytes != f.UncompressedSize64 {
			return fmt.Errorf("%q 解压大小与目录记录不一致", f.Name)
		}
		if isNative {
			contents.isNativeWorker = true
			contents.executableHashes = append(contents.executableHashes,
				f.Name+"="+hex.EncodeToString(h.Sum(nil)))
		}
		lower := strings.ToLower(f.Name)
		if strings.HasPrefix(lower, "sbom/") {
			contents.hasSBOM = true
		}
		return nil
	}

	if err := readEntry(manifestFile, true, false); err != nil {
		return nil, err
	}
	contents.parsedManifest, err = decodePackageManifest(contents.manifest)
	if err != nil {
		return nil, fmt.Errorf("manifest.json 不可解析: %w", err)
	}
	if err := validatePackageManifest(contents.parsedManifest, contents.manifest, ledger); err != nil {
		return nil, fmt.Errorf("manifest.json 校验失败: %w", err)
	}
	manifestPermissions, err := canonicalPermissions(contents.parsedManifest.Permissions)
	if err != nil || !permissionsEqual(contents.parsedManifest.Permissions, manifestPermissions) {
		return nil, fmt.Errorf("manifest permissions 非 canonical")
	}
	switch contents.parsedManifest.Entry.Type {
	case "web", "worker":
		if len(manifestPermissions) != 0 {
			return nil, fmt.Errorf("web/worker manifest 必须使用零原生权限")
		}
	case "launcher":
		if len(manifestPermissions) != 1 || manifestPermissions[0] != "process.launch.declared" {
			return nil, fmt.Errorf("launcher manifest 必须且只能声明 process.launch.declared")
		}
	default:
		return nil, fmt.Errorf("manifest entry.type 非法")
	}
	if contents.parsedManifest.Entry.Type == "worker" {
		workerPath := contents.parsedManifest.Entry.Path
		if err := validateArchivePath(workerPath); err != nil {
			return nil, fmt.Errorf("worker entry.path 非法: %w", err)
		}
		normalized := normalizedArchivePath(workerPath)
		workerFile, exists := ledger.byPath[normalized]
		if !exists || workerFile.FileInfo().IsDir() || workerFile.Name != workerPath || workerFile == manifestFile {
			return nil, fmt.Errorf("worker entry.path 必须唯一且精确指向包内文件")
		}
		ledger.native[normalized] = true
		if err := enforceNativeLedgerBudget(ledger); err != nil {
			return nil, err
		}
		contents.isNativeWorker = true
	}
	for _, f := range zr.File {
		if f == manifestFile || f.FileInfo().IsDir() {
			continue
		}
		if err := readEntry(f, false, ledger.native[ledger.pathByFile[f]]); err != nil {
			return nil, err
		}
	}
	return contents, nil
}
