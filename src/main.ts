import * as THREE from 'three';
import {
  AssetLoader,
  EnvironmentSpawner,
  type AssetManifest,
} from './environment/index.js';
import { environmentAssetManifest } from './environment/assetManifest.js';
import './style.css';

const CHUNK_LENGTH = 180;
const TERRAIN_HALF_WIDTH = 230;
const ROAD_WIDTH = 12;
const PLAYER_MAX_SPEED = 38;
const VISIBLE_BEHIND = 1;
const VISIBLE_AHEAD = 3;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`The Horizon Lanes page is missing "${selector}".`);
  }
  return element;
}

const root = requireElement<HTMLDivElement>('#game');
const loading = requireElement<HTMLDivElement>('#loading');
const loadingMessage = requireElement<HTMLParagraphElement>('#loading-message');
const startScreen = requireElement<HTMLDivElement>('#start-screen');
const errorScreen = requireElement<HTMLDivElement>('#error-screen');
const errorMessage = requireElement<HTMLParagraphElement>('#error-message');
const startButton = requireElement<HTMLButtonElement>('#start-button');
const pauseButton = requireElement<HTMLButtonElement>('#pause-button');
const hud = requireElement<HTMLElement>('#hud');
const speedDisplay = requireElement<HTMLElement>('#speed');
const distanceDisplay = requireElement<HTMLElement>('#distance');
const touchControls = requireElement<HTMLDivElement>('#touch-controls');

interface WorldChunk {
  readonly group: THREE.Group;
}

interface Controls {
  accelerate: boolean;
  brake: boolean;
  left: boolean;
  right: boolean;
}

function selectAssets<T extends AssetManifest>(manifest: T): AssetManifest {
  return {
    trees: [
      manifest.trees[0]!,
      manifest.trees[5]!,
      manifest.trees[25]!,
      manifest.trees[54]!,
      manifest.trees[69]!,
    ],
    bushes: manifest.bushes.slice(0, 4),
    rocks: [manifest.rocks[0]!, manifest.rocks[7]!, manifest.rocks[14]!],
    clouds: manifest.clouds.slice(0, 6),
    flowers: [
      '/Assets/Flowers/Flowers.glb',
      '/Assets/Flowers/CactusFlower_1.glb',
      '/Assets/Flowers/CactusFlowers_2.glb',
    ],
    stumps: manifest.stumps.slice(0, 4),
  };
}

const scene = new THREE.Scene();
scene.background = new THREE.Color('#a8cad2');
scene.fog = new THREE.Fog('#a8cad2', 125, 570);

const camera = new THREE.PerspectiveCamera(
  64,
  window.innerWidth / window.innerHeight,
  0.1,
  900,
);
camera.position.set(0, 6, -12);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
root.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight('#e4f4f5', '#536346', 2.1));
const sunlight = new THREE.DirectionalLight('#fff3d9', 2.3);
sunlight.position.set(-70, 110, 45);
scene.add(sunlight);

const vehicle = createVehicle();
scene.add(vehicle);

const controls: Controls = {
  accelerate: false,
  brake: false,
  left: false,
  right: false,
};

const worldChunks = new Map<number, WorldChunk>();

let environment: EnvironmentSpawner | undefined;
let ready = false;
let playing = false;
let speed = 0;
let distanceTravelled = 0;
let playerZ = 0;
let laneOffset = 0;
let lastChunkIndex = Number.NaN;

void startGame().catch((error: unknown) => {
  console.error('Failed to initialize Horizon Lanes.', error);
  loading.hidden = true;
  errorMessage.textContent =
    error instanceof Error ? error.message : 'An unexpected error occurred while loading the game.';
  errorScreen.hidden = false;
});

async function startGame(): Promise<void> {
  const loader = new AssetLoader();
  const assetManifest = selectAssets(environmentAssetManifest);
  loadingMessage.textContent = `Loading ${countAssets(assetManifest)} low-poly models…`;
  await loader.preload(assetManifest);

  environment = new EnvironmentSpawner({
    scene,
    assets: loader,
    terrainHeightAt,
    roadDistanceAt,
    roadClearanceRadius: ROAD_WIDTH * 0.5 + 5,
    seed: 2026,
    categories: {
      Trees: {
        densityPerSquareUnit: 0.0011,
        scaleRange: [3.2, 5.2],
        yScaleVariation: [0.94, 1.14],
      },
      Bushes: { densityPerSquareUnit: 0.001 },
      Plants: { densityPerSquareUnit: 0.006 },
      Flowers: { densityPerSquareUnit: 0.002 },
      Rocks: { densityPerSquareUnit: 0.001 },
      'Logs and Stumps': { densityPerSquareUnit: 0.0002 },
    },
    clouds: {
      densityPerSquareUnit: 0.00022,
      height: 95,
      drift: new THREE.Vector2(0.7, 0.22),
    },
  });

  syncChunks();
  ready = true;
  loading.hidden = true;
  startScreen.hidden = false;
}

function countAssets(manifest: AssetManifest): number {
  return Object.values(manifest).reduce((total, urls) => total + urls.length, 0);
}

function createVehicle(): THREE.Group {
  const car = new THREE.Group();
  car.name = 'player-car';

  const paint = new THREE.MeshStandardMaterial({
    color: '#b85f43',
    roughness: 0.4,
    metalness: 0.14,
  });
  const dark = new THREE.MeshStandardMaterial({ color: '#222a2c', roughness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({
    color: '#273d43',
    roughness: 0.2,
    metalness: 0.1,
  });
  const lamp = new THREE.MeshStandardMaterial({
    color: '#f5e6b1',
    emissive: '#bb9637',
    emissiveIntensity: 0.35,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.72, 4.1), paint);
  body.position.y = 0.84;
  body.castShadow = true;
  car.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.8, 1.9), glass);
  cabin.position.set(0, 1.55, -0.1);
  cabin.castShadow = true;
  car.add(cabin);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.16, 1.9), paint);
  roof.position.set(0, 1.98, -0.1);
  roof.castShadow = true;
  car.add(roof);

  for (const x of [-1.04, 1.04]) {
    for (const z of [-1.35, 1.35]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.32, 12), dark);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.48, z);
      wheel.castShadow = true;
      car.add(wheel);
    }

    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.2, 0.08), lamp);
    headlight.position.set(x * 0.72, 0.92, 2.08);
    car.add(headlight);
  }

  const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.22, 0.2), dark);
  bumper.position.set(0, 0.52, 2.08);
  car.add(bumper);

  car.position.y = terrainHeightAt(0, 0);
  return car;
}

function syncChunks(): void {
  const currentIndex = Math.floor(playerZ / CHUNK_LENGTH);
  if (currentIndex === lastChunkIndex) return;
  lastChunkIndex = currentIndex;

  const first = currentIndex - VISIBLE_BEHIND;
  const last = currentIndex + VISIBLE_AHEAD;
  for (let index = first; index <= last; index += 1) {
    if (!worldChunks.has(index)) {
      const bounds = {
        id: `road-${index}`,
        minX: -TERRAIN_HALF_WIDTH,
        maxX: TERRAIN_HALF_WIDTH,
        minZ: index * CHUNK_LENGTH,
        maxZ: (index + 1) * CHUNK_LENGTH,
      };
      worldChunks.set(index, { group: createWorldChunk(bounds.minZ, bounds.maxZ) });
      environment?.spawnChunk(bounds);
    }
  }

  for (const [index, chunk] of worldChunks) {
    if (index < first || index > last) {
      scene.remove(chunk.group);
      disposeWorldChunk(chunk.group);
      worldChunks.delete(index);
      environment?.unloadChunk(`road-${index}`);
    }
  }
}

function createWorldChunk(startZ: number, endZ: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `terrain-road:${startZ}`;
  group.add(createTerrain(startZ, endZ));
  group.add(createRoad(startZ, endZ));
  scene.add(group);
  return group;
}

function createTerrain(startZ: number, endZ: number): THREE.Mesh {
  const columns = 72;
  const rows = 48;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= rows; row += 1) {
    const z = startZ + ((endZ - startZ) * row) / rows;
    for (let column = 0; column <= columns; column += 1) {
      const x = -TERRAIN_HALF_WIDTH + (2 * TERRAIN_HALF_WIDTH * column) / columns;
      const height = terrainHeightAt(x, z);
      positions.push(x, height, z);

      const variation =
        0.5 +
        0.22 * Math.sin(x * 0.037 + z * 0.021) +
        0.16 * Math.sin(z * 0.055 - x * 0.019) +
        THREE.MathUtils.clamp(height / 34, -0.12, 0.12);
      const color = new THREE.Color('#647b4f').lerp(
        new THREE.Color('#99a373'),
        THREE.MathUtils.clamp(variation, 0, 1),
      );
      colors.push(color.r, color.g, color.b);
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * (columns + 1) + column;
      const b = a + columns + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    flatShading: true,
  });
  const terrain = new THREE.Mesh(geometry, material);
  terrain.receiveShadow = true;
  return terrain;
}

function createRoad(startZ: number, endZ: number): THREE.Mesh {
  const rows = 90;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= rows; row += 1) {
    const z = startZ + ((endZ - startZ) * row) / rows;
    const centerX = roadCenterX(z);
    const slope = (roadCenterX(z + 0.5) - roadCenterX(z - 0.5));
    const perpendicularLength = Math.hypot(1, slope);
    const halfX = ((ROAD_WIDTH / 2) / perpendicularLength);
    const halfZ = ((ROAD_WIDTH / 2) * slope) / perpendicularLength;
    const leftX = centerX - halfX;
    const leftZ = z + halfZ;
    const rightX = centerX + halfX;
    const rightZ = z - halfZ;
    positions.push(leftX, terrainHeightAt(leftX, leftZ) + 0.14, leftZ);
    positions.push(rightX, terrainHeightAt(rightX, rightZ) + 0.14, rightZ);
  }

  for (let row = 0; row < rows; row += 1) {
    const a = row * 2;
    const b = a + 2;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: '#343a3b',
    roughness: 0.93,
    side: THREE.DoubleSide,
  });
  const road = new THREE.Mesh(geometry, material);
  road.receiveShadow = true;
  road.position.y += 0.015;
  return road;
}

function disposeWorldChunk(group: THREE.Group): void {
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
  group.clear();
}

function roadCenterX(z: number): number {
  return 18 * Math.sin(z * 0.0032) + 8 * Math.sin(z * 0.0081 + 0.7);
}

function terrainHeightAt(x: number, z: number): number {
  return (
    11 * Math.sin(x * 0.009 + z * 0.0027) +
    7.5 * Math.sin(z * 0.006 - x * 0.006) +
    2.6 * Math.sin(x * 0.025 + z * 0.016) *
      Math.cos(z * 0.019 - x * 0.009)
  );
}

function roadDistanceAt(x: number, z: number): number {
  let nearestSquared = Number.POSITIVE_INFINITY;
  for (let offset = -18; offset <= 18; offset += 3) {
    const sampleZ = z + offset;
    const dx = x - roadCenterX(sampleZ);
    const dz = z - sampleZ;
    nearestSquared = Math.min(nearestSquared, dx * dx + dz * dz);
  }
  return Math.sqrt(nearestSquared);
}

function update(deltaSeconds: number): void {
  if (!playing) return;

  const delta = Math.min(deltaSeconds, 0.05);
  const accelerating = controls.accelerate;
  const braking = controls.brake;
  const steering = Number(controls.right) - Number(controls.left);

  if (accelerating) speed = Math.min(PLAYER_MAX_SPEED, speed + 10 * delta);
  else speed = Math.max(0, speed - 2.2 * delta);
  if (braking) speed = Math.max(0, speed - 24 * delta);

  const offRoadDistance = Math.max(0, Math.abs(laneOffset) - ROAD_WIDTH / 2);
  if (offRoadDistance > 0) {
    speed = Math.max(0, speed - offRoadDistance * 0.55 * delta);
  }

  laneOffset += steering * (2.2 + speed * 0.48) * delta;
  laneOffset = THREE.MathUtils.clamp(laneOffset, -24, 24);

  const previousZ = playerZ;
  playerZ += speed * delta;
  distanceTravelled += playerZ - previousZ;

  const centerX = roadCenterX(playerZ);
  vehicle.position.set(centerX + laneOffset, terrainHeightAt(centerX + laneOffset, playerZ), playerZ);
  vehicle.rotation.y = Math.atan2(
    roadCenterX(playerZ + 2) - roadCenterX(playerZ - 2),
    4,
  );
  vehicle.rotation.z = -steering * 0.055;

  const target = new THREE.Vector3(
    vehicle.position.x,
    vehicle.position.y + 5.5,
    vehicle.position.z - 12,
  );
  camera.position.lerp(target, 1 - Math.exp(-4.5 * delta));
  camera.lookAt(
    vehicle.position.x,
    vehicle.position.y + 1.1,
    vehicle.position.z + 7,
  );

  environment?.update(delta);
  syncChunks();
  speedDisplay.textContent = Math.round(speed * 3.6).toString();
  distanceDisplay.textContent = `${(distanceTravelled / 1000).toFixed(1)} km`;
}

let previousFrameTime = performance.now();
function frame(timestamp: number): void {
  requestAnimationFrame(frame);
  const delta = Math.max(0, (timestamp - previousFrameTime) / 1000);
  previousFrameTime = timestamp;
  if (ready) update(delta);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

startButton.addEventListener('click', () => {
  playing = true;
  startScreen.hidden = true;
  hud.hidden = false;
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    touchControls.hidden = false;
  }
});

pauseButton.addEventListener('click', () => {
  playing = !playing;
  pauseButton.textContent = playing ? 'Ⅱ' : '▶';
});

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
    event.preventDefault();
  }
  if (key === 'w' || key === 'arrowup') controls.accelerate = true;
  if (key === 's' || key === 'arrowdown') controls.brake = true;
  if (key === 'a' || key === 'arrowleft') controls.left = true;
  if (key === 'd' || key === 'arrowright') controls.right = true;
  if (key === 'escape' && ready) {
    playing = !playing;
    pauseButton.textContent = playing ? 'Ⅱ' : '▶';
  }
});

window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'w' || key === 'arrowup') controls.accelerate = false;
  if (key === 's' || key === 'arrowdown') controls.brake = false;
  if (key === 'a' || key === 'arrowleft') controls.left = false;
  if (key === 'd' || key === 'arrowright') controls.right = false;
});

window.addEventListener('blur', resetControls);

touchControls.querySelectorAll<HTMLButtonElement>('[data-control]').forEach((button) => {
  const control = button.dataset.control as keyof Controls;
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    controls[control] = true;
  });
  const release = () => {
    controls[control] = false;
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
});

function resetControls(): void {
  controls.accelerate = false;
  controls.brake = false;
  controls.left = false;
  controls.right = false;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
});
