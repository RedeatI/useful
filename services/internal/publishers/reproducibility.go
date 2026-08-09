// 复现构建验证（Phase RC：可信 reproducibleBuildVerified）。
//
// 状态机：unknown / claimed / verification-pending / verified / failed。
// 绝不因 manifest 自称 reproducible=true 就判定 verified。
// verified 必须满足两种被明确记录的策略之一：
//
//	策略 A（dual-build）：相同 source commit + 相同构建定义，两个独立构建执行，
//	  输出规范化后摘要一致，且构建器身份可追踪。
//	策略 B（provenance）：受支持的 provenance，签名有效，builder identity 符合
//	  该源策略，source commit / 构建参数 / artifact digest 完全匹配，策略版本记录。
package publishers

import (
	"strings"
	"time"
)

type ReproStatus string

const (
	ReproUnknown             ReproStatus = "unknown"
	ReproClaimed             ReproStatus = "claimed"              // 作者声明，未验证
	ReproVerificationPending ReproStatus = "verification-pending" // 已受理，验证中
	ReproVerified            ReproStatus = "verified"             // 官方验证通过
	ReproFailed              ReproStatus = "failed"
)

// 策略版本（记录到证据，便于审计与将来演进）。
const (
	ReproStrategyDualBuild  = "dual-build"
	ReproStrategyProvenance = "provenance"
	ReproPolicyVersion      = "repro-policy-v1"
)

// DualBuildEvidence 策略 A 证据。
type DualBuildEvidence struct {
	SourceCommit string `json:"sourceCommit"`
	BuildDefRef  string `json:"buildDefRef"` // 构建定义引用（如 workflow 文件 + 版本）
	// 两个独立构建执行的规范化输出摘要
	BuildADigest string `json:"buildADigest"`
	BuildBDigest string `json:"buildBDigest"`
	// 构建器身份（可追踪）
	BuilderA string `json:"builderA"`
	BuilderB string `json:"builderB"`
}

// ProvenanceEvidence 策略 B 证据。
type ProvenanceEvidence struct {
	SourceCommit string `json:"sourceCommit"`
	// provenance 声明的 artifact 摘要
	ArtifactDigest string `json:"artifactDigest"`
	// builder 身份（须符合该源策略）
	BuilderID string `json:"builderId"`
	// provenance 签名验证结果（由 Sigstore/Ed25519 验证器产出后传入）
	SignatureVerified bool `json:"signatureVerified"`
	// 构建参数摘要（须与登记一致）
	BuildParamsDigest string `json:"buildParamsDigest"`
}

// ReproPolicy 该源接受的复现构建策略约束。
type ReproPolicy struct {
	// 允许的 builder 身份（provenance 策略）；空表示不接受 provenance 策略
	AllowedBuilders []string
	// 期望的 source commit（防止 provenance 指向他处）
	ExpectedSourceCommit string
	// 期望的 artifact digest（当前制品）
	ExpectedArtifactDigest string
	// 期望的构建参数摘要（provenance）
	ExpectedBuildParamsDigest string
}

// ReproResult 验证结果（服务端保存证据与策略版本）。
type ReproResult struct {
	Status        ReproStatus `json:"status"`
	Strategy      string      `json:"strategy,omitempty"`
	PolicyVersion string      `json:"policyVersion"`
	FailureReason string      `json:"failureReason,omitempty"`
	VerifiedAt    *time.Time  `json:"verifiedAt,omitempty"`
}

// VerifyDualBuild 策略 A：两个独立构建的规范化摘要一致且构建器可追踪。
func VerifyDualBuild(ev DualBuildEvidence, expectedCommit, expectedDigest string, now time.Time) ReproResult {
	base := ReproResult{Strategy: ReproStrategyDualBuild, PolicyVersion: ReproPolicyVersion}
	fail := func(reason string) ReproResult { r := base; r.Status = ReproFailed; r.FailureReason = reason; return r }

	if ev.SourceCommit == "" || ev.SourceCommit != expectedCommit {
		return fail("source commit 不匹配")
	}
	if ev.BuildADigest == "" || ev.BuildBDigest == "" {
		return fail("缺少构建摘要")
	}
	if !strings.EqualFold(ev.BuildADigest, ev.BuildBDigest) {
		return fail("两次独立构建摘要不一致")
	}
	// 双构建摘要必须等于当前制品摘要（绑定）
	if !strings.EqualFold(ev.BuildADigest, expectedDigest) {
		return fail("构建摘要与当前制品不绑定")
	}
	if ev.BuilderA == "" || ev.BuilderB == "" {
		return fail("构建器身份不可追踪")
	}
	if ev.BuilderA == ev.BuilderB {
		return fail("两次构建须由独立构建器执行")
	}
	t := now
	return ReproResult{Status: ReproVerified, Strategy: ReproStrategyDualBuild,
		PolicyVersion: ReproPolicyVersion, VerifiedAt: &t}
}

// VerifyProvenance 策略 B：可信 provenance，签名有效，builder/commit/digest/参数全匹配。
func VerifyProvenance(ev ProvenanceEvidence, policy ReproPolicy, now time.Time) ReproResult {
	base := ReproResult{Strategy: ReproStrategyProvenance, PolicyVersion: ReproPolicyVersion}
	fail := func(reason string) ReproResult { r := base; r.Status = ReproFailed; r.FailureReason = reason; return r }

	if !ev.SignatureVerified {
		return fail("provenance 签名无效")
	}
	if ev.SourceCommit == "" || ev.SourceCommit != policy.ExpectedSourceCommit {
		return fail("source commit 与策略不符")
	}
	if ev.ArtifactDigest == "" || !strings.EqualFold(ev.ArtifactDigest, policy.ExpectedArtifactDigest) {
		return fail("provenance artifact 摘要与当前制品不绑定")
	}
	if ev.BuildParamsDigest == "" || ev.BuildParamsDigest != policy.ExpectedBuildParamsDigest {
		return fail("构建参数摘要与登记不符")
	}
	if !builderAllowed(ev.BuilderID, policy.AllowedBuilders) {
		return fail("builder identity 不符合该源策略")
	}
	t := now
	return ReproResult{Status: ReproVerified, Strategy: ReproStrategyProvenance,
		PolicyVersion: ReproPolicyVersion, VerifiedAt: &t}
}

func builderAllowed(builder string, allowed []string) bool {
	if builder == "" || len(allowed) == 0 {
		return false
	}
	for _, a := range allowed {
		if a == builder {
			return true
		}
	}
	return false
}

// ClaimOnly 仅有作者声明（reproducible=true）但无验证证据时的状态。
func ClaimOnly(claimed bool) ReproResult {
	if claimed {
		return ReproResult{Status: ReproClaimed, PolicyVersion: ReproPolicyVersion}
	}
	return ReproResult{Status: ReproUnknown, PolicyVersion: ReproPolicyVersion}
}
