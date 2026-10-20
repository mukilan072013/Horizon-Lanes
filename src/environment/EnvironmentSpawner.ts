import * as THREE from 'three';
import {
  AssetLoader,
  type EnvironmentCategory,
  type LoadedEnvironmentAsset,
} from './AssetLoader.js';

export interface TerrainChunkBounds {
  readonly id: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface CategorySpawnConfig {
  /** Candidate instances per square world unit before density-noise rejection. */
  readonly densityPerSquareUnit: number;
  readonly noiseScale: number;
  /** Value-noise range is [-1, 1]; candidates below this value are rejected. */
  readonly noiseThreshold: number;
  readonly scaleRange: readonly [number, number];
  /** Multiplicative variation applied to Y scale, independent of X/Z scale. */
  readonly yScaleVariation: readonly [number, number];
  readonly heightOffset: readonly [number, number];
}

export interface CloudSpawnConfig {
  readonly densityPerSquareUnit: number;
  readonly noiseScale: number;
  readonly noiseThreshold: number;
  readonly scaleRange: readonly [number, number];
  readonly height: number;
  readonly heightVariation: number;
  readonly drift: THREE.Vector2;
}

export interface EnvironmentSpawnerOptions {
  readonly scene: THREE.Scene;
  readonly assets: AssetLoader;
  readonly terrainHeightAt: (x: number, z: number) => number;
  /** Horizontal distance from (x, z) to the nearest point on the road spline. */
  readonly roadDistanceAt: (x: number, z: number) => number;
  readonly roadClearanceRadius: number;
  readonly seed?: number;
  readonly categories?: Partial<
    Record<Exclude<EnvironmentCategory, 'Clouds'>, Partial<CategorySpawnConfig>>
  >;
  readonly clouds?: Partial<CloudSpawnConfig>;
}

const DEFAULT_CATEGORY_CONFIG: CategorySpawnConfig = {
  densityPerSquareUnit: 0.025,
  noiseScale: 0.035,
  noiseThreshold: -0.15,
  scaleRange: [0.85, 1.15],
  yScaleVariation: [0.92, 1.08],
  heightOffset: [0, 0.08],
};

const DEFAULT_CATEGORY_SETTINGS: Record<
  Exclude<EnvironmentCategory, 'Clouds'>,
  Partial<CategorySpawnConfig>
> = {
  Trees: { densityPerSquareUnit: 0.012, noiseScale: 0.018 },
  Bushes: { densityPerSquareUnit: 0.035, noiseScale: 0.04 },
  Plants: { densityPerSquareUnit: 0.12, noiseScale: 0.08 },
  Flowers: { densityPerSquareUnit: 0.07, noiseScale: 0.09 },
  Rocks: { densityPerSquareUnit: 0.025, noiseScale: 0.03 },
  'Logs and Stumps': { densityPerSquareUnit: 0.008, noiseScale: 0.025 },
};

const DEFAULT_CLOUD_CONFIG: CloudSpawnConfig = {
  densityPerSquareUnit: 0.00035,
  noiseScale: 0.004,
  noiseThreshold: 0.05,
  scaleRange: [0.8, 1.25],
  height: 90,
  heightVariation: 18,
  drift: new THREE.Vector2(0.8, 0.25),
};

type GroundCategory = Exclude<EnvironmentCategory, 'Clouds'>;
const GROUND_CATEGORIES: readonly GroundCategory[] = [
  'Trees',
  'Bushes',
  'Plants',
  'Flowers',
  'Rocks',
  'Logs and Stumps',
];

type Placement = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationY: number;
  readonly scale: number;
  readonly yScale: number;
};

interface InstanceBatch {
  readonly asset: LoadedEnvironmentAsset;
  readonly placements: Placement[];
}

interface CloudDrift {
  readonly group: THREE.Group;
  readonly velocity: THREE.Vector2;
}

interface ChunkRecord {
  readonly root: THREE.Group;
  readonly cloudDrifts: readonly CloudDrift[];
}

/**
 * Produces deterministic placements from world coordinates, so adjacent chunks
 * agree at their boundaries and do not need persistent per-instance metadata.
 */
export class EnvironmentSpawner {
  private readonly scene: THREE.Scene;
  private readonly assets: AssetLoader;
  private readonly terrainHeightAt: (x: number, z: number) => number;
  private readonly roadDistanceAt: (x: number, z: number) => number;
  private readonly roadClearanceRadius: number;
  private readonly seed: number;
  private readonly categorySettings: Record<GroundCategory, CategorySpawnConfig>;
  private readonly cloudConfig: CloudSpawnConfig;
  private readonly chunks = new Map<string, ChunkRecord>();
  private readonly scratchObject = new THREE.Object3D();
  private readonly scratchMatrix = new THREE.Matrix4();

  constructor(options: EnvironmentSpawnerOptions) {
    if (
      !Number.isFinite(options.roadClearanceRadius) ||
      options.roadClearanceRadius < 0
    ) {
      throw new RangeError('roadClearanceRadius must be finite and zero or greater.');
    }

    this.scene = options.scene;
    this.assets = options.assets;
    this.terrainHeightAt = options.terrainHeightAt;
    this.roadDistanceAt = options.roadDistanceAt;
    this.roadClearanceRadius = options.roadClearanceRadius;
    this.seed = options.seed ?? 1;
    this.cloudConfig = { ...DEFAULT_CLOUD_CONFIG, ...options.clouds };

    this.categorySettings = {
      Trees: {
        ...DEFAULT_CATEGORY_CONFIG,
        ...DEFAULT_CATEGORY_SETTINGS.Trees,
        ...options.categories?.Trees,
      },
      Bushes: {
        ...DEFAULT_CATEGORY_CONFIG,
        ...DEFAULT_CATEGORY_SETTINGS.Bushes,
        ...options.categories?.Bushes,
      },
      Plants: {
        ...DEFAULT_CATEGORY_CONFIG,
        ...DEFAULT_CATEGORY_SETTINGS.Plants,
        ...options.categories?.Plants,
      },
      Flowers: {
        ...DEFAULT_CATEGORY_CONFIG,
        ...DEFAULT_CATEGORY_SETTINGS.Flowers,
        ...options.categories?.Flowers,
      },
      Rocks: {
        ...DEFAULT_CATEGORY_CONFIG,
        ...DEFAULT_CATEGORY_SETTINGS.Rocks,
        ...options.categories?.Rocks,
      },
      'Logs and Stumps': {
        ...DEFAULT_CATEGORY_CONFIG,
        ...DEFAULT_CATEGORY_SETTINGS['Logs and Stumps'],
        ...options.categories?.['Logs and Stumps'],
      },
    };

    this.validateConfig();
  }

  /** Build and attach all category batches for a terrain chunk. */
  spawnChunk(bounds: TerrainChunkBounds): void {
    this.validateBounds(bounds);
    if (this.chunks.has(bounds.id)) {
      throw new Error(`Environment chunk "${bounds.id}" is already spawned.`);
    }

    const root = new THREE.Group();
    root.name = `environment:${bounds.id}`;
    const cloudDrifts: CloudDrift[] = [];

    try {
      for (const category of GROUND_CATEGORIES) {
        const batches = this.collectGroundPlacements(category, bounds);
        this.addBatches(root, batches, bounds.id);
      }

      const clouds = this.collectCloudPlacements(bounds);
      for (const batch of clouds) {
        const driftGroup = new THREE.Group();
        driftGroup.name = `clouds:${bounds.id}:${batch.asset.url}`;
        root.add(driftGroup);
        this.addAssetBatch(driftGroup, batch, bounds.id);
        cloudDrifts.push({
          group: driftGroup,
          velocity: this.cloudConfig.drift.clone(),
        });
      }

      this.scene.add(root);
      this.chunks.set(bounds.id, { root, cloudDrifts });
    } catch (error) {
      this.disposeGroup(root);
      throw error;
    }
  }

  /** Call once per frame with delta time in seconds. */
  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('deltaSeconds must be a finite, non-negative number.');
    }

    for (const chunk of this.chunks.values()) {
      for (const cloud of chunk.cloudDrifts) {
        cloud.group.position.x += cloud.velocity.x * deltaSeconds;
        cloud.group.position.z += cloud.velocity.y * deltaSeconds;
      }
    }
  }

  /** Remove a chunk and release its instance buffers without disposing cached assets. */
  unloadChunk(id: string): void {
    const chunk = this.chunks.get(id);
    if (!chunk) return;

    this.scene.remove(chunk.root);
    this.disposeGroup(chunk.root);
    this.chunks.delete(id);
  }

  /** Unload every spawned chunk. The AssetLoader cache remains reusable. */
  dispose(): void {
    for (const id of this.chunks.keys()) this.unloadChunk(id);
  }

  private collectGroundPlacements(
    category: GroundCategory,
    bounds: TerrainChunkBounds,
  ): InstanceBatch[] {
    const config = this.categorySettings[category];
    const assets = this.assets.getAssets(category);
    const byAsset = new Map<LoadedEnvironmentAsset, Placement[]>();
    // One jittered point per cell gives the requested baseline density in world space.
    const spacing = 1 / Math.sqrt(config.densityPerSquareUnit);
    const minCellX = Math.floor(bounds.minX / spacing);
    const maxCellX = Math.ceil(bounds.maxX / spacing);
    const minCellZ = Math.floor(bounds.minZ / spacing);
    const maxCellZ = Math.ceil(bounds.maxZ / spacing);
    const noiseSeed = this.seed ^ this.hashString(category);

    for (let cellZ = minCellZ; cellZ < maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX < maxCellX; cellX += 1) {
        const key = this.hash(category, cellX, cellZ);
        const random = this.random01(key);
        const x = (cellX + random) * spacing;
        const z = (cellZ + this.random01(key ^ 0x9e3779b9)) * spacing;
        if (x < bounds.minX || x >= bounds.maxX || z < bounds.minZ || z >= bounds.maxZ) {
          continue;
        }

        if (
          this.sampleNoise(
            x * config.noiseScale,
            z * config.noiseScale,
            noiseSeed,
          ) < config.noiseThreshold
        ) {
          continue;
        }

        const asset = this.selectAsset(
          assets,
          this.random01(key ^ 0x85ebca6b),
          category,
        );
        const scale = this.range(
          config.scaleRange,
          this.random01(key ^ 0x165667b1),
        );
        const roadDistance = this.roadDistanceAt(x, z);
        if (!Number.isFinite(roadDistance) || roadDistance < 0) {
          throw new Error(`roadDistanceAt returned an invalid distance at (${x}, ${z}).`);
        }
        if (
          roadDistance <
          this.roadClearanceRadius + asset.footprintRadius * scale
        ) {
          continue;
        }

        const groundY = this.terrainHeightAt(x, z);
        if (!Number.isFinite(groundY)) {
          throw new Error(`terrainHeightAt returned an invalid height at (${x}, ${z}).`);
        }

        const placement: Placement = {
          x,
          y:
            groundY +
            this.range(config.heightOffset, this.random01(key ^ 0xc2b2ae35)),
          z,
          rotationY: this.random01(key ^ 0x27d4eb2f) * Math.PI * 2,
          scale,
          yScale: this.range(
            config.yScaleVariation,
            this.random01(key ^ 0xd3a2646c),
          ),
        };
        const placements = byAsset.get(asset) ?? [];
        placements.push(placement);
        byAsset.set(asset, placements);
      }
    }

    return [...byAsset].map(([asset, placements]) => ({ asset, placements }));
  }

  private collectCloudPlacements(bounds: TerrainChunkBounds): InstanceBatch[] {
    const config = this.cloudConfig;
    const assets = this.assets.getAssets('Clouds');
    const byAsset = new Map<LoadedEnvironmentAsset, Placement[]>();
    // Use the same global grid as ground placement so chunk boundaries stay stable.
    const spacing = 1 / Math.sqrt(config.densityPerSquareUnit);
    const minCellX = Math.floor(bounds.minX / spacing);
    const maxCellX = Math.ceil(bounds.maxX / spacing);
    const minCellZ = Math.floor(bounds.minZ / spacing);
    const maxCellZ = Math.ceil(bounds.maxZ / spacing);
    const noiseSeed = this.seed ^ this.hashString('Clouds');

    for (let cellZ = minCellZ; cellZ < maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX < maxCellX; cellX += 1) {
        const key = this.hash('Clouds', cellX, cellZ);
        const x = (cellX + this.random01(key)) * spacing;
        const z = (cellZ + this.random01(key ^ 0x9e3779b9)) * spacing;
        if (x < bounds.minX || x >= bounds.maxX || z < bounds.minZ || z >= bounds.maxZ) {
          continue;
        }
        if (
          this.sampleNoise(
            x * config.noiseScale,
            z * config.noiseScale,
            noiseSeed,
          ) < config.noiseThreshold
        ) {
          continue;
        }

        const asset = this.selectAsset(
          assets,
          this.random01(key ^ 0x85ebca6b),
          'Clouds',
        );
        const placements = byAsset.get(asset) ?? [];
        placements.push({
          x,
          y: config.height + (this.random01(key ^ 0xc2b2ae35) * 2 - 1) * config.heightVariation,
          z,
          rotationY: this.random01(key ^ 0x27d4eb2f) * Math.PI * 2,
          scale: this.range(config.scaleRange, this.random01(key ^ 0x165667b1)),
          yScale: 1,
        });
        byAsset.set(asset, placements);
      }
    }
    return [...byAsset].map(([asset, placements]) => ({ asset, placements }));
  }

  private addBatches(
    root: THREE.Group,
    batches: readonly InstanceBatch[],
    chunkId: string,
  ): void {
    for (const batch of batches) {
      const group = new THREE.Group();
      group.name = `instances:${chunkId}:${batch.asset.url}`;
      root.add(group);
      this.addAssetBatch(group, batch, chunkId);
    }
  }

  private addAssetBatch(
    group: THREE.Group,
    batch: InstanceBatch,
    chunkId: string,
  ): void {
    // Each source primitive/material is one draw batch; instance count does not add draw calls.
    for (const part of batch.asset.parts) {
      const mesh = new THREE.InstancedMesh(
        part.geometry,
        part.material,
        batch.placements.length,
      );
      mesh.name = `instances:${chunkId}:${batch.asset.url}`;
      mesh.castShadow = part.castShadow;
      mesh.receiveShadow = part.receiveShadow;
      mesh.frustumCulled = true;

      batch.placements.forEach((placement, index) => {
        this.scratchObject.position.set(placement.x, placement.y, placement.z);
        this.scratchObject.rotation.set(0, placement.rotationY, 0);
        this.scratchObject.scale.set(
          placement.scale,
          placement.scale * placement.yScale,
          placement.scale,
        );
        this.scratchObject.updateMatrix();
        this.scratchMatrix.multiplyMatrices(
          this.scratchObject.matrix,
          part.localMatrix,
        );
        mesh.setMatrixAt(index, this.scratchMatrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }

  private disposeGroup(root: THREE.Group): void {
    root.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    root.clear();
  }

  private validateBounds(bounds: TerrainChunkBounds): void {
    const values = [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ];
    if (
      !bounds.id ||
      values.some((value) => !Number.isFinite(value)) ||
      bounds.minX >= bounds.maxX ||
      bounds.minZ >= bounds.maxZ
    ) {
      throw new RangeError('Chunk bounds must have an id and finite, non-empty extents.');
    }
  }

  private validateConfig(): void {
    const configs = [
      ...Object.values(this.categorySettings),
      this.cloudConfig,
    ];
    for (const config of configs) {
      if (
        !Number.isFinite(config.densityPerSquareUnit) ||
        config.densityPerSquareUnit <= 0 ||
        !Number.isFinite(config.noiseScale) ||
        config.noiseScale <= 0 ||
        !Number.isFinite(config.noiseThreshold) ||
        config.noiseThreshold < -1 ||
        config.noiseThreshold > 1
      ) {
        throw new RangeError('Spawn density/noise settings are outside their valid ranges.');
      }
    }

    for (const config of [
      ...Object.values(this.categorySettings),
      this.cloudConfig,
    ]) {
      this.validateRange(config.scaleRange, 'scaleRange', true);
    }
    for (const config of Object.values(this.categorySettings)) {
      this.validateRange(config.yScaleVariation, 'yScaleVariation', true);
      this.validateRange(config.heightOffset, 'heightOffset', false);
    }
    if (
      !Number.isFinite(this.cloudConfig.height) ||
      !Number.isFinite(this.cloudConfig.heightVariation) ||
      this.cloudConfig.heightVariation < 0 ||
      !Number.isFinite(this.cloudConfig.drift.x) ||
      !Number.isFinite(this.cloudConfig.drift.y)
    ) {
      throw new RangeError('Cloud height, heightVariation, and drift must be finite.');
    }
  }

  private validateRange(
    range: readonly [number, number],
    name: string,
    strictlyPositive: boolean,
  ): void {
    const [min, max] = range;
    if (
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min > max ||
      (strictlyPositive && min <= 0)
    ) {
      throw new RangeError(`${name} must be an ordered range${strictlyPositive ? ' above zero' : ''}.`);
    }
  }

  private range(range: readonly [number, number], t: number): number {
    return range[0] + (range[1] - range[0]) * t;
  }

  private selectAsset(
    assets: readonly LoadedEnvironmentAsset[],
    random: number,
    category: EnvironmentCategory,
  ): LoadedEnvironmentAsset {
    const asset = assets[Math.floor(random * assets.length)];
    if (!asset) {
      throw new Error(`No loaded assets are available for "${category}".`);
    }
    return asset;
  }

  private hash(category: EnvironmentCategory, x: number, z: number): number {
    let value = this.seed ^ this.hashString(category);
    value = Math.imul(value ^ x, 0x45d9f3b);
    value = Math.imul(value ^ z, 0x45d9f3b);
    value ^= value >>> 16;
    return value >>> 0;
  }

  private hashString(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return hash;
  }

  private random01(value: number): number {
    let hash = value >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
    hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
    hash ^= hash >>> 16;
    return (hash >>> 0) / 0x100000000;
  }

  /** Smooth 2D gradient Perlin noise with deterministic lattice gradients. */
  private sampleNoise(x: number, z: number, salt: number): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const tx = x - x0;
    const tz = z - z0;
    const sx = this.fade(tx);
    const sz = this.fade(tz);
    const g00 = this.gradientDot(x0, z0, tx, tz, salt);
    const g10 = this.gradientDot(x0 + 1, z0, tx - 1, tz, salt);
    const g01 = this.gradientDot(x0, z0 + 1, tx, tz - 1, salt);
    const g11 = this.gradientDot(x0 + 1, z0 + 1, tx - 1, tz - 1, salt);
    const top = g00 + (g10 - g00) * sx;
    const bottom = g01 + (g11 - g01) * sx;
    return THREE.MathUtils.clamp(top + (bottom - top) * sz, -1, 1);
  }

  private fade(value: number): number {
    return value * value * value * (value * (value * 6 - 15) + 10);
  }

  private gradientDot(
    x: number,
    z: number,
    dx: number,
    dz: number,
    salt: number,
  ): number {
    let value = salt ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1);
    value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
    value = Math.imul(value ^ (value >>> 12), 0x297a2d39);
    value ^= value >>> 15;
    switch (value & 7) {
      case 0:
        return dx;
      case 1:
        return -dx;
      case 2:
        return dz;
      case 3:
        return -dz;
      case 4:
        return (dx + dz) * Math.SQRT1_2;
      case 5:
        return (dx - dz) * Math.SQRT1_2;
      case 6:
        return (-dx + dz) * Math.SQRT1_2;
      default:
        return (-dx - dz) * Math.SQRT1_2;
    }
  }
}
