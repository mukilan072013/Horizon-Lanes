import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import {
  ASSET_CATEGORIES,
  environmentAssetManifest,
  type AssetCategory,
  type AssetManifest,
} from './assetManifest.js';

/** Categories retained for compatibility with EnvironmentSpawner. */
export const ENVIRONMENT_CATEGORIES = [
  'Trees',
  'Bushes',
  'Plants',
  'Flowers',
  'Rocks',
  'Logs and Stumps',
  'Clouds',
] as const;

export type EnvironmentCategory = (typeof ENVIRONMENT_CATEGORIES)[number];
export type { AssetCategory, AssetManifest };

export interface AssetPart {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material | THREE.Material[];
  /** Transform of this primitive relative to the glTF scene root. */
  readonly localMatrix: THREE.Matrix4;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
}

export interface LoadedEnvironmentAsset {
  readonly url: string;
  readonly parts: readonly AssetPart[];
  /** Maximum horizontal extent from the glTF origin, in source model units. */
  readonly footprintRadius: number;
}

export interface AssetLoaderOptions {
  /** Configure this when the asset pack contains Draco-compressed geometry. */
  readonly dracoDecoderPath?: string;
}

/**
 * Loads and caches GLB templates. Returned templates are shared; use
 * cloneAsset() to get an independently transformable scene instance.
 */
export class AssetLoader {
  private readonly gltfLoader: GLTFLoader;
  private readonly dracoDecoderPath: string | undefined;
  private dracoLoader: import('three/addons/loaders/DRACOLoader.js').DRACOLoader | undefined;
  private readonly cache = new Map<string, THREE.Group>();
  private readonly inFlight = new Map<string, Promise<THREE.Group>>();
  private readonly byCategory = new Map<AssetCategory, readonly LoadedEnvironmentAsset[]>();
  private readonly partsByUrl = new Map<string, LoadedEnvironmentAsset>();

  constructor(options: AssetLoaderOptions = {}) {
    this.gltfLoader = new GLTFLoader();
    this.dracoDecoderPath = options.dracoDecoderPath;
  }

  /** Loads every manifest model once and returns cached, clone-ready templates keyed by URL. */
  async loadAllAssets(): Promise<Map<string, THREE.Group>> {
    await this.preload();
    return new Map(this.cache);
  }

  /** Preload a custom manifest, or the repository's default asset manifest. */
  async preload(manifest: AssetManifest = environmentAssetManifest): Promise<void> {
    await this.configureDraco();
    const loadedCategories = await Promise.all(
      ASSET_CATEGORIES.map(async (category) => {
        const urls = manifest[category];
        if (urls.length === 0) {
          throw new Error(`No environment asset URLs configured for "${category}".`);
        }

        const assets = await Promise.all(urls.map((url) => this.load(url)));
        return [category, assets] as const;
      }),
    );

    for (const [category, assets] of loadedCategories) {
      this.byCategory.set(category, assets);
    }
  }

  /** Create a safe scene clone; geometry and materials remain shared and cached. */
  cloneAsset(url: string): THREE.Group {
    const template = this.cache.get(url);
    if (!template) {
      throw new Error(`Asset "${url}" is not loaded. Call loadAllAssets() first.`);
    }
    const clone = cloneSkeleton(template);
    if (!(clone instanceof THREE.Group)) {
      throw new Error(`Cloning asset "${url}" did not produce a THREE.Group.`);
    }
    return clone;
  }

  /**
   * Return static mesh primitives for the chunk InstancedMesh spawner.
   * Plants are not a requested manifest category, so they currently reuse the
   * flower category; logs and stumps share the "stumps" manifest category.
   */
  getAssets(category: EnvironmentCategory): readonly LoadedEnvironmentAsset[] {
    const manifestCategory = this.toManifestCategory(category);
    const assets = this.byCategory.get(manifestCategory);
    if (!assets) {
      throw new Error(
        `Assets for "${category}" are not loaded. Call loadAllAssets() before spawning chunks.`,
      );
    }
    return assets;
  }

  /** Release the optional Draco decoder when this loader is permanently retired. */
  dispose(): void {
    this.dracoLoader?.dispose();
  }

  private async load(url: string): Promise<LoadedEnvironmentAsset> {
    let asset = this.partsByUrl.get(url);
    if (!asset) {
      const template = await this.loadTemplate(url);
      asset = this.createAssetParts(url, template);
      this.partsByUrl.set(url, asset);
    }
    return asset;
  }

  private async configureDraco(): Promise<void> {
    if (!this.dracoDecoderPath || this.dracoLoader) return;
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(this.dracoDecoderPath);
    this.gltfLoader.setDRACOLoader(dracoLoader);
    this.dracoLoader = dracoLoader;
  }

  private loadTemplate(url: string): Promise<THREE.Group> {
    const cached = this.cache.get(url);
    if (cached) return Promise.resolve(cached);

    const pending = this.inFlight.get(url);
    if (pending) return pending;

    const request = this.gltfLoader
      .loadAsync(url)
      .then((gltf) => {
        const template = gltf.scene;
        template.name ||= url;
        this.cache.set(url, template);
        return template;
      })
      .finally(() => {
        this.inFlight.delete(url);
      });

    this.inFlight.set(url, request);
    return request;
  }

  private createAssetParts(
    url: string,
    root: THREE.Group,
  ): LoadedEnvironmentAsset {
    root.updateMatrixWorld(true);
    const inverseRoot = root.matrixWorld.clone().invert();
    const parts: AssetPart[] = [];
    let footprintRadius = 0;

    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (node instanceof THREE.SkinnedMesh) {
        throw new Error(
          `Skinned environment asset "${url}" cannot be rendered as a static instance.`,
        );
      }

      const localMatrix = inverseRoot.clone().multiply(node.matrixWorld);
      node.geometry.computeBoundingBox();
      const bounds = node.geometry.boundingBox;
      if (!bounds) {
        throw new Error(`Environment asset "${url}" has a mesh without bounds.`);
      }

      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z).applyMatrix4(localMatrix);
            footprintRadius = Math.max(
              footprintRadius,
              Math.hypot(corner.x, corner.z),
            );
          }
        }
      }

      parts.push({
        geometry: node.geometry,
        material: node.material,
        localMatrix,
        castShadow: node.castShadow,
        receiveShadow: node.receiveShadow,
      });
    });

    if (parts.length === 0) {
      throw new Error(`Environment asset "${url}" contains no mesh primitives.`);
    }

    return { url, parts, footprintRadius };
  }

  private toManifestCategory(category: EnvironmentCategory): AssetCategory {
    switch (category) {
      case 'Trees':
        return 'trees';
      case 'Bushes':
        return 'bushes';
      case 'Plants':
      case 'Flowers':
        return 'flowers';
      case 'Rocks':
        return 'rocks';
      case 'Logs and Stumps':
        return 'stumps';
      case 'Clouds':
        return 'clouds';
    }
  }
}
