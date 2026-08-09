export const PRODUCT_VERSION_FILES = Object.freeze([
  "package.json",
  "apps/useful/package.json",
  "packages/useful-cli/package.json",
  "packages/useful-sdk/package.json",
  "apps/useful/src-tauri/tauri.conf.json",
]);

export const RELEASE_CHANNELS = Object.freeze(["stable", "beta", "nightly"]);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assertVersionForChannel(version, channel) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`version 不是合法 SemVer: ${version}`);
  if (!RELEASE_CHANNELS.includes(channel)) {
    throw new Error(`channel 必须是 ${RELEASE_CHANNELS.join("|")}: ${channel}`);
  }
  const prerelease = match[4] ?? "";
  if (channel === "stable" && prerelease) {
    throw new Error("stable 版本不得包含 prerelease");
  }
  if (channel === "beta" && !/^beta\.(0|[1-9]\d*)$/.test(prerelease)) {
    throw new Error("beta 版本必须使用 -beta.N");
  }
  if (
    channel === "nightly" &&
    !/^nightly\.\d{8}\.(0|[1-9]\d*)$/.test(prerelease)
  ) {
    throw new Error("nightly 版本必须使用 -nightly.YYYYMMDD.RUN");
  }
  return true;
}

export function inferChannel(version) {
  const prerelease = SEMVER.exec(version)?.[4] ?? "";
  if (!prerelease) return "stable";
  if (/^beta\.(0|[1-9]\d*)$/.test(prerelease)) return "beta";
  if (/^nightly\.\d{8}\.(0|[1-9]\d*)$/.test(prerelease)) return "nightly";
  throw new Error(`无法从版本推断发布通道: ${version}`);
}
