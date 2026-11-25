import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("system", messageCatalog.messages);
export interface VersionCardEntry {
  readonly title: string;
  readonly notes?: readonly string[];
}

export interface VersionCardRelease {
  readonly version: string;
  readonly entries: readonly VersionCardEntry[];
}

export interface RuntimeVersion {
  readonly version?: string;
  readonly revision?: string;
  readonly modified?: boolean;
  readonly modules: readonly { readonly name: string; readonly revision: string }[];
  readonly changelog?: readonly VersionCardRelease[];
}

const versionLabel = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)*$/u;

function line(value: string): string | undefined {
  const clean = value.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
  if (clean) return [...clean].slice(0, 240).join("");
}

/** Project only explicit first-party release notes supplied with the runtime version. */
export function publicVersionChanges(runtime?: RuntimeVersion): readonly VersionCardRelease[] {
  const releases: VersionCardRelease[] = [];
  const versions = new Set<string>();
  for (const release of runtime?.changelog ?? []) {
    const version = release.version;
    if (version.length > 80 || !versionLabel.test(version) || versions.has(version)) continue;
    const entries: VersionCardEntry[] = [];
    for (const entry of release.entries.slice(0, 20)) {
      const title = line(entry.title);
      if (!title) continue;
      const notes = (entry.notes ?? []).slice(0, 6).map(line).filter((text): text is string => text !== undefined);
      entries.push({ title, ...(notes.length > 0 && { notes }) });
    }
    if (!entries.length) continue;
    versions.add(version);
    releases.push({ version, entries });
    if (releases.length === 5) break;
  }
  return releases;
}

export function versionCardSections(runtime?: RuntimeVersion): readonly VersionCardRelease[] {
  const version = runtime?.version || $t("version-card-data.text_53fd643fa6");
  const revision = runtime?.revision?.slice(0, 12) || $t("version-card-data.text_63cffd447f");
  const modified = runtime?.modified ? $t("version-card-data.text_c453df6435") : "";
  const modules = runtime?.modules.map(({ name, revision }) => `${name}　${revision.slice(0, 12)}`) ?? [];
  const releases = publicVersionChanges(runtime);
  const current = releases.find(release => release.version === version);
  return [
    { version, entries: [
      { title: $t("version-card-data.text_368320762b", { "revision": revision, "modified": modified }) },
      { title: $t("version-card-data.text_0f5e7ba3d2"), notes: modules.length ? modules : [$t("version-card-data.text_780ac58fe9")] },
      ...(current?.entries ?? []),
    ] },
    ...releases.filter(release => release.version !== version).slice(0, 4),
  ];
}
