import type { ExtensionManifest } from "@relay/contracts";
import { validateExtensionManifest } from "@relay/contracts";

export class ExtensionRegistry {
  private readonly manifests = new Map<string, ExtensionManifest>();
  install(manifest: ExtensionManifest): void {
    validateExtensionManifest(manifest);
    const previous = this.manifests.get(manifest.id);
    if (previous && previous.version === manifest.version) throw new Error(`Extension already installed: ${manifest.id}@${manifest.version}`);
    this.manifests.set(manifest.id, Object.freeze({ ...manifest, contributions: [...manifest.contributions] }));
  }
  revoke(id: string): void { const manifest = this.manifests.get(id); if (manifest) this.manifests.set(id, { ...manifest, revoked: true }); }
  uninstall(id: string): boolean { return this.manifests.delete(id); }
  get(id: string): ExtensionManifest | undefined { return this.manifests.get(id); }
  list(): readonly ExtensionManifest[] { return [...this.manifests.values()].filter(m => !m.revoked).sort((a, b) => a.id.localeCompare(b.id)); }
}
