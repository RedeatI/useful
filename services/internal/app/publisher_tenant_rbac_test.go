package app_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	authpkg "useful.dev/source/internal/auth"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/publishers"
)

func issueBoundToken(t *testing.T, e *env, id, publisherKeyID string, roles []domain.Role) string {
	t.Helper()
	now := time.Now().UTC()
	if err := e.repo.Identities().CreateIdentity(context.Background(), &domain.Identity{
		ID: id, DisplayName: id, Kind: "service-account", Roles: roles,
		PublisherKeyID: publisherKeyID, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	plaintext, hash, err := authpkg.NewAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.repo.Identities().CreateToken(context.Background(), &domain.APIToken{
		ID: "tok_" + id, IdentityID: id, TokenHash: hash,
		Scopes: domain.ScopesForRoles(roles), ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	return plaintext
}

func getBearer(t *testing.T, e *env, path, token string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.http.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := e.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestPublisherTenantRBAC_OpaqueResourcesAndGlobalRoles(t *testing.T) {
	e := newEnv(t)
	publisherB, _ := newSigningPublisher(t, e, "publisher-b")
	ownerA := issueBoundToken(t, e, "owner-a", publisherKey, []domain.Role{domain.RolePublisherOwner})
	ownerB := issueBoundToken(t, e, "owner-b", publisherB, []domain.Role{domain.RolePublisherOwner})
	sourceAdmin := issueBoundToken(t, e, "source-global", "", []domain.Role{domain.RoleSourceAdmin})
	securityReviewer := issueBoundToken(t, e, "security-global", "", []domain.Role{domain.RoleSecurityReviewer})

	// Body-carried publisher key is tenant checked.
	crossCreate := e.postJSONBearer("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": strings.Repeat("ab", 32), "size": 1,
	}, ownerB)
	defer crossCreate.Body.Close()
	if crossCreate.StatusCode != http.StatusNotFound {
		t.Fatalf("publisher B 创建 publisher A 上传会话应隐藏为 404，实际 %d", crossCreate.StatusCode)
	}

	created := decode[map[string]string](t, e.postJSONBearer("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": strings.Repeat("ab", 32), "size": 1,
	}, ownerA))
	put, _ := http.NewRequest(http.MethodPut, e.http.URL+created["uploadUrl"], bytes.NewReader([]byte("x")))
	put.Header.Set("Authorization", "Bearer "+ownerB)
	crossContent, err := e.http.Client().Do(put)
	if err != nil {
		t.Fatal(err)
	}
	defer crossContent.Body.Close()
	if crossContent.StatusCode != http.StatusNotFound {
		t.Fatalf("publisher B 写 publisher A opaque session 应隐藏为 404，实际 %d", crossContent.StatusCode)
	}

	crossRelease := e.postJSONBearer("/v1/publisher/releases", map[string]any{
		"uploadSessionId": created["uploadSessionId"], "toolId": "cross.tool", "name": "Cross",
		"version": "1.0.0", "channel": "stable", "platform": "windows", "arch": "x86_64",
	}, ownerB)
	defer crossRelease.Body.Close()
	if crossRelease.StatusCode != http.StatusNotFound {
		t.Fatalf("publisher B 用 publisher A opaque session 发版应隐藏为 404，实际 %d", crossRelease.StatusCode)
	}

	useful := makeUsefulArtifact(t, "tenant.tool", "1.0.0", 10)
	artifactID := e.uploadAndRelease(useful, "tenant.tool", "1.0.0", "free")
	crossGet := getBearer(t, e, "/v1/publisher/releases/"+artifactID, ownerB)
	if crossGet.StatusCode != http.StatusNotFound {
		t.Fatalf("publisher B 读取 publisher A artifact 应隐藏为 404，实际 %d", crossGet.StatusCode)
	}
	var crossProblem map[string]any
	if err := json.NewDecoder(crossGet.Body).Decode(&crossProblem); err != nil {
		t.Fatal(err)
	}
	crossGet.Body.Close()
	missingGet := getBearer(t, e, "/v1/publisher/releases/art_missing", ownerB)
	var missingProblem map[string]any
	if err := json.NewDecoder(missingGet.Body).Decode(&missingProblem); err != nil {
		t.Fatal(err)
	}
	missingGet.Body.Close()
	if missingGet.StatusCode != http.StatusNotFound || crossProblem["title"] != missingProblem["title"] ||
		crossProblem["detail"] != missingProblem["detail"] {
		t.Fatalf("opaque missing/cross-tenant responses must be indistinguishable: cross=%#v missing=%#v",
			crossProblem, missingProblem)
	}
	globalGet := getBearer(t, e, "/v1/publisher/releases/"+artifactID, sourceAdmin)
	defer globalGet.Body.Close()
	if globalGet.StatusCode != http.StatusOK {
		t.Fatalf("source-admin 应可全局读取 publisher artifact，实际 %d", globalGet.StatusCode)
	}

	crossWithdraw := e.postJSONBearer("/v1/publisher/releases/"+artifactID+"/withdraw",
		map[string]string{"reason": "cross tenant"}, ownerB)
	defer crossWithdraw.Body.Close()
	if crossWithdraw.StatusCode != http.StatusNotFound {
		t.Fatalf("publisher B 撤回 publisher A artifact 应隐藏为 404，实际 %d", crossWithdraw.StatusCode)
	}

	crossAdvisory := e.postJSONBearer("/v1/publisher/advisories", map[string]any{
		"publisherKeyId": publisherKey, "toolId": "tenant.tool", "severity": "high", "summary": "cross",
	}, ownerB)
	defer crossAdvisory.Body.Close()
	if crossAdvisory.StatusCode != http.StatusNotFound {
		t.Fatalf("publisher B 创建 publisher A 公告应隐藏为 404，实际 %d", crossAdvisory.StatusCode)
	}
	globalAdvisory := e.postJSONBearer("/v1/publisher/advisories", map[string]any{
		"publisherKeyId": publisherKey, "toolId": "tenant.tool", "severity": "high", "summary": "global review",
	}, securityReviewer)
	defer globalAdvisory.Body.Close()
	if globalAdvisory.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(globalAdvisory.Body)
		t.Fatalf("security-reviewer 公告应保持全局语义: %d %s", globalAdvisory.StatusCode, body)
	}

	newPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	newKeyID := "ed25519:" + hex.EncodeToString(newPublic)
	crossSignature := ed25519.Sign(publisherPrivateKey, []byte("useful-key-rotation-v1\n"+newKeyID))
	crossRotate := e.postJSONBearer("/v1/publisher/keys/rotate", map[string]string{
		"oldKeyId": publisherKey, "newKeyId": newKeyID,
		"crossSignature": hex.EncodeToString(crossSignature),
	}, ownerB)
	defer crossRotate.Body.Close()
	if crossRotate.StatusCode != http.StatusNotFound {
		t.Fatalf("publisher B 轮换 publisher A old key 应隐藏为 404，实际 %d", crossRotate.StatusCode)
	}
	globalRotate := e.postJSONBearer("/v1/publisher/keys/rotate", map[string]string{
		"oldKeyId": publisherKey, "newKeyId": newKeyID,
		"crossSignature": hex.EncodeToString(crossSignature),
	}, sourceAdmin)
	defer globalRotate.Body.Close()
	if globalRotate.StatusCode != http.StatusOK {
		t.Fatalf("source-admin 应可全局轮换 publisher key，实际 %d", globalRotate.StatusCode)
	}
	events, _ := e.repo.Audit().List(context.Background(), 200)
	foundActor := false
	for _, event := range events {
		if event.Action == "publisher.key_rotated" && event.Actor == "source-global" {
			foundActor = true
		}
	}
	if !foundActor {
		t.Fatal("密钥轮换审计必须记录真实认证 actor")
	}
}

func TestPublisherTenantRBAC_IdentityBindingFailsClosed(t *testing.T) {
	e := newEnv(t)

	missing := e.postJSON("/v1/admin/identities", map[string]any{
		"id": "owner-missing", "roles": []string{"publisher-owner"},
	}, true)
	defer missing.Body.Close()
	if missing.StatusCode != http.StatusBadRequest {
		t.Fatalf("publisher role 缺绑定应 400，实际 %d", missing.StatusCode)
	}
	unregisteredKey := "ed25519:" + strings.Repeat("11", ed25519.PublicKeySize)
	unregistered := e.postJSON("/v1/admin/identities", map[string]any{
		"id": "owner-unknown", "roles": []string{"publisher-owner"}, "publisherKeyId": unregisteredKey,
	}, true)
	defer unregistered.Body.Close()
	if unregistered.StatusCode != http.StatusForbidden {
		t.Fatalf("publisher role 未登记绑定应 403，实际 %d", unregistered.StatusCode)
	}

	// Corrupt/pre-existing identities are rejected again at authentication.
	now := time.Now().UTC()
	if err := e.repo.Identities().CreateIdentity(context.Background(), &domain.Identity{
		ID: "corrupt-owner", DisplayName: "corrupt", Kind: "service-account",
		Roles: []domain.Role{domain.RolePublisherOwner}, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	plaintext, hash, err := authpkg.NewAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.repo.Identities().CreateToken(context.Background(), &domain.APIToken{
		ID: "tok_corrupt", IdentityID: "corrupt-owner", TokenHash: hash,
		Scopes: []string{domain.ScopePublisherWrite}, ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	resp := e.postJSONBearer("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": strings.Repeat("ab", 32), "size": 1,
	}, plaintext)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无绑定 publisher 身份认证必须 fail closed 为 401，实际 %d", resp.StatusCode)
	}

	if err := e.repo.Identities().CreateIdentity(context.Background(), &domain.Identity{
		ID: "unknown-role", DisplayName: "unknown", Kind: "service-account",
		Roles: []domain.Role{"future-publisher-admin"}, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	unknownPlaintext, unknownHash, err := authpkg.NewAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.repo.Identities().CreateToken(context.Background(), &domain.APIToken{
		ID: "tok_unknown_role", IdentityID: "unknown-role", TokenHash: unknownHash,
		Scopes: []string{domain.ScopePublisherWrite}, ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	unknownResp := e.postJSONBearer("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": strings.Repeat("ab", 32), "size": 1,
	}, unknownPlaintext)
	defer unknownResp.Body.Close()
	if unknownResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("未知持久化 role 认证必须 fail closed 为 401，实际 %d", unknownResp.StatusCode)
	}
}

func TestPublisherProofsAreMutuallyExclusive(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "dual.proof", "1.0.0", 10)
	sum := sha256.Sum256(useful)
	sessionID := e.uploadFor(publisherKey, useful)
	signature := ed25519.Sign(publisherPrivateKey,
		publishers.SigningPayload("dual.proof", "1.0.0", hex.EncodeToString(sum[:])))
	resp := e.postJSON("/v1/publisher/releases", map[string]any{
		"uploadSessionId": sessionID, "toolId": "dual.proof", "name": "Dual",
		"version": "1.0.0", "channel": "stable", "platform": "windows", "arch": "x86_64",
		"publisherSignature": hex.EncodeToString(signature), "sigstoreBundle": map[string]any{"bundle": true},
	}, true)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("同时提供两种 publisher proof 必须 400，实际 %d", resp.StatusCode)
	}
}
