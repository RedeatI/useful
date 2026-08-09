// 复现构建验证测试：状态机 + 两种策略正向/负向 + catalog 推导。
package publishers

import (
	"testing"
	"time"
)

const (
	rCommit = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	rDigest = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
)

func TestRepro_DualBuildVerified(t *testing.T) {
	now := time.Now()
	ev := DualBuildEvidence{
		SourceCommit: rCommit, BuildDefRef: "ci/build.yml@v1",
		BuildADigest: rDigest, BuildBDigest: rDigest,
		BuilderA: "builder-1", BuilderB: "builder-2",
	}
	res := VerifyDualBuild(ev, rCommit, rDigest, now)
	if res.Status != ReproVerified || res.Strategy != ReproStrategyDualBuild {
		t.Fatalf("双构建一致应 verified，得到 %s (%s)", res.Status, res.FailureReason)
	}
	if res.PolicyVersion != ReproPolicyVersion || res.VerifiedAt == nil {
		t.Fatal("应记录策略版本与验证时间")
	}
}

func TestRepro_DualBuildDigestMismatch(t *testing.T) {
	now := time.Now()
	ev := DualBuildEvidence{
		SourceCommit: rCommit, BuildADigest: rDigest,
		BuildBDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		BuilderA:     "b1", BuilderB: "b2",
	}
	if VerifyDualBuild(ev, rCommit, rDigest, now).Status != ReproFailed {
		t.Fatal("两次构建摘要不一致必须 failed")
	}
}

func TestRepro_DualBuildNotBoundToArtifact(t *testing.T) {
	now := time.Now()
	// 两次构建一致，但与当前制品摘要不绑定
	ev := DualBuildEvidence{
		SourceCommit: rCommit, BuildADigest: rDigest, BuildBDigest: rDigest,
		BuilderA: "b1", BuilderB: "b2",
	}
	other := "1111111111111111111111111111111111111111111111111111111111111111"
	if VerifyDualBuild(ev, rCommit, other, now).Status != ReproFailed {
		t.Fatal("构建摘要与当前制品不绑定必须 failed")
	}
}

func TestRepro_DualBuildSameBuilderRejected(t *testing.T) {
	now := time.Now()
	ev := DualBuildEvidence{
		SourceCommit: rCommit, BuildADigest: rDigest, BuildBDigest: rDigest,
		BuilderA: "same", BuilderB: "same",
	}
	if VerifyDualBuild(ev, rCommit, rDigest, now).Status != ReproFailed {
		t.Fatal("同一构建器的两次构建不算独立，必须 failed")
	}
}

func TestRepro_ProvenanceVerified(t *testing.T) {
	now := time.Now()
	policy := ReproPolicy{
		AllowedBuilders:           []string{"https://github.com/useful/ci/.github/workflows/release.yml@refs/tags/v1"},
		ExpectedSourceCommit:      rCommit,
		ExpectedArtifactDigest:    rDigest,
		ExpectedBuildParamsDigest: "params-digest-1",
	}
	ev := ProvenanceEvidence{
		SourceCommit: rCommit, ArtifactDigest: rDigest,
		BuilderID:         policy.AllowedBuilders[0],
		SignatureVerified: true, BuildParamsDigest: "params-digest-1",
	}
	res := VerifyProvenance(ev, policy, now)
	if res.Status != ReproVerified || res.Strategy != ReproStrategyProvenance {
		t.Fatalf("合法 provenance 应 verified，得到 %s (%s)", res.Status, res.FailureReason)
	}
}

func TestRepro_ProvenanceTampered(t *testing.T) {
	now := time.Now()
	policy := ReproPolicy{
		AllowedBuilders: []string{"builder-x"}, ExpectedSourceCommit: rCommit,
		ExpectedArtifactDigest: rDigest, ExpectedBuildParamsDigest: "p1",
	}
	base := ProvenanceEvidence{
		SourceCommit: rCommit, ArtifactDigest: rDigest, BuilderID: "builder-x",
		SignatureVerified: true, BuildParamsDigest: "p1",
	}
	// 签名无效
	bad := base
	bad.SignatureVerified = false
	if VerifyProvenance(bad, policy, now).Status != ReproFailed {
		t.Fatal("provenance 签名无效必须 failed")
	}
	// 错误 builder identity
	bad = base
	bad.BuilderID = "rogue-builder"
	if VerifyProvenance(bad, policy, now).Status != ReproFailed {
		t.Fatal("错误 builder identity 必须 failed")
	}
	// artifact 摘要不绑定
	bad = base
	bad.ArtifactDigest = "0000000000000000000000000000000000000000000000000000000000000000"
	if VerifyProvenance(bad, policy, now).Status != ReproFailed {
		t.Fatal("provenance 摘要不绑定必须 failed")
	}
	// 构建参数不符
	bad = base
	bad.BuildParamsDigest = "p2"
	if VerifyProvenance(bad, policy, now).Status != ReproFailed {
		t.Fatal("构建参数摘要不符必须 failed")
	}
}

func TestRepro_ClaimNeverVerified(t *testing.T) {
	// 仅作者声明不构成 verified
	if ClaimOnly(true).Status != ReproClaimed {
		t.Fatal("作者声明应为 claimed，绝不是 verified")
	}
	if ClaimOnly(false).Status != ReproUnknown {
		t.Fatal("无声明应为 unknown")
	}
}
