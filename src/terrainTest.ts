import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

export interface TerrainTestOptions {
  readonly terrainHeightAt: (x: number, z: number) => number;
  readonly seed?: number;
  readonly roadsideOffset?: number;
  readonly roadsideDepth?: number;
  readonly sampleCount?: number;
}

interface AssetSet {
  readonly trees: readonly string[];
  readonly rocks: readonly string[];
  readonly bushes: readonly string[];
}

const TEST_ASSETS: AssetSet = {
  trees: [
    '/Assets/Trees/Common Trees/CommonTree_1.glb',
    '/Assets/Trees/Birch Trees/BirchTree_1.glb',
    '/Assets/Trees/Pine Trees/PineTree_1.glb',
    '/Assets/Trees/Willow Trees/Willow_1.glb',
  ],
  rocks: [
    '/Assets/Rocks/Rock_1.glb',
    '/Assets/Rocks/Rock_Moss_1.glb',
    '/Assets/Rocks/Rock_Snow_1.glb',
  ],
  bushes: [
    '/Assets/Bushes/Bush_1.glb',
    '/Assets/Bushes/Bush_2.glb',
    '/Assets/Bushes/BushBerries_1.glb',
  ],
};

const MODEL_HEIGHTS: Readonly<Record<keyof AssetSet, number>> = {
  trees: 8.5,
  rocks: 2.2,
  bushes: 1,
};

const loader = new GLTFLoader();
const templateCache = new Map<string, Promise<THREE.Group>>();
const UP = new THREE.Vector3(0, 1, 0);
const scratchBounds = new THREE.Box3();
const scratchSize = new THREE.Vector3();
const scratchTangent = new THREE.Vector3();
const scratchNormal = new THREE.Vector3();
const scratchSide = new THREE.Vector3();

/**
 * Loads cached GLB templates and scatters scaled clones along both sides of a
 * Catmull-Rom road. The returned group can be added to a scene and disposed
 * when the test terrain is removed.
 */
export async function createTerrainTestScenery(
  road: THREE.CatmullRomCurve3,
  options: TerrainTestOptions,
): Promise<THREE.Group> {
  const random = createRandom(options.seed ?? 1234);
  const root = new THREE.Group();
  root.name = 'terrain-test-scenery';
  const roadsideOffset = options.roadsideOffset ?? 8;
  const roadsideDepth = options.roadsideDepth ?? 35;
  const sampleCount = options.sampleCount ?? 72;

  if (
    !Number.isFinite(roadsideOffset) ||
    roadsideOffset < 0 ||
    !Number.isFinite(roadsideDepth) ||
    roadsideDepth <= 0 ||
    !Number.isInteger(sampleCount) ||
    sampleCount <= 0
  ) {
    throw new RangeError('Roadside spacing and sampleCount must be valid positive values.');
  }

  try {
    const [trees, rocks, bushes] = await Promise.all([
      loadTemplates(TEST_ASSETS.trees),
      loadTemplates(TEST_ASSETS.rocks),
      loadTemplates(TEST_ASSETS.bushes),
    ]);

    scatterCategory(root, road, trees, 'trees', options.terrainHeightAt, random, sampleCount, roadsideOffset, roadsideDepth);
    scatterCategory(root, road, bushes, 'bushes', options.terrainHeightAt, random, sampleCount, roadsideOffset, roadsideDepth);
    scatterCategory(root, road, rocks, 'rocks', options.terrainHeightAt, random, sampleCount, roadsideOffset, roadsideDepth);
    return root;
  } catch (error) {
    disposeScenery(root);
    throw error;
  }
}

function loadTemplates(urls: readonly string[]): Promise<THREE.Group[]> {
  return Promise.all(
    urls.map((url) => {
      let request = templateCache.get(url);
      if (!request) {
        request = loader.loadAsync(url).then((gltf) => gltf.scene);
        templateCache.set(url, request);
      }
      return request;
    }),
  );
}

function scatterCategory(
  root: THREE.Group,
  road: THREE.CatmullRomCurve3,
  templates: readonly THREE.Group[],
  category: keyof AssetSet,
  terrainHeightAt: (x: number, z: number) => number,
  random: () => number,
  sampleCount: number,
  roadsideOffset: number,
  roadsideDepth: number,
): void {
  const targetHeight = MODEL_HEIGHTS[category];

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const t = (sample + 0.5) / sampleCount;
    const point = road.getPointAt(t);
    road.getTangentAt(t, scratchTangent);
    scratchTangent.y = 0;
    scratchTangent.normalize();
    scratchSide.set(scratchTangent.z, 0, -scratchTangent.x).normalize();

    for (const sideSign of [-1, 1]) {
      const template = templates[Math.floor(random() * templates.length)];
      if (!template) continue;

      const lateralDistance =
        roadsideOffset + 2 + random() * roadsideDepth;
      const x = point.x + scratchSide.x * lateralDistance * sideSign;
      const z = point.z + scratchSide.z * lateralDistance * sideSign;
      const terrainY = terrainHeightAt(x, z);
      if (!Number.isFinite(terrainY)) {
        throw new Error(`Terrain height is not finite at (${x}, ${z}).`);
      }

      const instance = cloneSkeleton(template);
      instance.name = `${category}-instance`;
      const modelHeight = getTemplateHeight(template);
      if (!Number.isFinite(modelHeight) || modelHeight <= 0) {
        throw new Error(`Loaded ${category} asset has invalid vertical bounds.`);
      }

      const scale = targetHeight / modelHeight;
      instance.scale.setScalar(scale);
      instance.position.set(x, 0, z);
      instance.rotation.y = random() * Math.PI * 2;

      // Keep trees upright; let lower plants and rocks follow the local ground plane.
      if (category !== 'trees') {
        terrainNormalAt(terrainHeightAt, x, z, scratchNormal);
        instance.quaternion.setFromUnitVectors(UP, scratchNormal);
        instance.rotateY(random() * Math.PI * 2);
      }

      instance.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });

      root.add(instance);
      instance.updateWorldMatrix(true, true);
      scratchBounds.setFromObject(instance);
      instance.position.y += terrainY - scratchBounds.min.y;
    }
  }
}

const templateHeightCache = new WeakMap<THREE.Group, number>();

function getTemplateHeight(template: THREE.Group): number {
  const cached = templateHeightCache.get(template);
  if (cached !== undefined) return cached;

  const bounds = new THREE.Box3().setFromObject(template);
  bounds.getSize(scratchSize);
  templateHeightCache.set(template, scratchSize.y);
  return scratchSize.y;
}

function terrainNormalAt(
  heightAt: (x: number, z: number) => number,
  x: number,
  z: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  const epsilon = 0.5;
  const dx = (heightAt(x + epsilon, z) - heightAt(x - epsilon, z)) / (2 * epsilon);
  const dz = (heightAt(x, z + epsilon) - heightAt(x, z - epsilon)) / (2 * epsilon);
  return target.set(-dx, 1, -dz).normalize();
}

function createRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Remove cloned scene nodes without disposing geometry shared by templates. */
export function disposeScenery(root: THREE.Group): void {
  root.clear();
}
