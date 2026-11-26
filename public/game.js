import * as THREE from "/vendor/three.module.js";
import "/track-geometry.js";

const joinScreen = document.querySelector("#join-screen");
const raceScreen = document.querySelector("#race-screen");
const storeScreen = document.querySelector("#store-screen");
const garageScreen = document.querySelector("#garage-screen");
const joinForm = document.querySelector("#join-form");
const joinError = document.querySelector("#join-error");
const connectionLabel = document.querySelector("#connection-label");
const accountForm = document.querySelector("#account-form");
const accountUsername = document.querySelector("#account-username");
const accountPassword = document.querySelector("#account-password");
const accountSummary = document.querySelector("#account-summary");
const accountBalance = document.querySelector("#account-balance");
const accountError = document.querySelector("#account-error");
const logoutButton = document.querySelector("#logout-button");
const gameView = document.querySelector("#game-view");
const minimap = document.querySelector("#race-minimap");
const startButton = document.querySelector("#start-button");
const restartButton = document.querySelector("#restart-button");
const leaveButton = document.querySelector("#leave-button");
const raceMessage = document.querySelector("#race-message");
const standingsList = document.querySelector("#standings-list");
const raceClock = document.querySelector("#race-clock");
const rewardSummary = document.querySelector("#reward-summary");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 350);
const clock = new THREE.Clock();
const carViews = new Map();
const previewViews = new Map();
const heldKeys = new Set();
const cosmeticCategories = ["color", "camo", "wheels", "helmet", "spoiler", "trail"];
const categoryLabels = {
  color: "Colores",
  camo: "Diseños",
  wheels: "Ruedas",
  helmet: "Cascos",
  spoiler: "Alerones",
  trail: "Estelas",
};
let socket;
let playerId = null;
let latestState = null;
let catalogData = null;
let trackData = null;
let accountProfile = null;
let sessionToken = localStorage.getItem("race2win.sessionToken") || "";
let selectedCategory = "color";
let selectedStoreItemId = null;
let selectedGarageItemId = null;
let rewardSignature = "";
let sceneReady = false;
let sceneTrackId = null;
let renderLoopStarted = false;
let lastSentInput = { throttle: 0, brake: 0, steer: 0 };
let lastLeaderboardSignature = "";
let lastLeaderboardUpdate = 0;
let lastRenderedPhase = null;
let raceElapsedMs = 0;
let raceClockSyncAt = 0;
let raceClockRunning = false;
let lastClockUpdateAt = 0;

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
gameView.appendChild(renderer.domElement);

function seededNoise(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeTexture(baseColor, marks, seed, repeat = 1, surface = "asphalt") {
  const canvas = document.createElement("canvas");
  const size = 256;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const random = seededNoise(seed);
  context.fillStyle = baseColor;
  context.fillRect(0, 0, size, size);

  for (let index = 0; index < 68; index += 1) {
    const radiusX = 5 + random() * 18;
    const radiusY = 4 + random() * 14;
    const centerX = random() * size;
    const centerY = random() * size;
    const vertices = [];
    const vertexCount = 5 + Math.floor(random() * 4);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const angle = (vertex / vertexCount) * Math.PI * 2;
      const variation = 0.65 + random() * 0.5;
      vertices.push([
        centerX + Math.cos(angle) * radiusX * variation,
        centerY + Math.sin(angle) * radiusY * variation,
      ]);
    }

    const xOffsets = [0];
    const yOffsets = [0];
    const patchAlpha = 0.035 + random() * 0.055;
    const patchColor = marks[Math.floor(random() * marks.length)];
    if (centerX < radiusX) xOffsets.push(size);
    if (centerX > size - radiusX) xOffsets.push(-size);
    if (centerY < radiusY) yOffsets.push(size);
    if (centerY > size - radiusY) yOffsets.push(-size);
    for (const offsetX of xOffsets) {
      for (const offsetY of yOffsets) {
        context.beginPath();
        vertices.forEach(([x, y], vertex) => {
          if (vertex === 0) context.moveTo(x + offsetX, y + offsetY);
          else context.lineTo(x + offsetX, y + offsetY);
        });
        context.closePath();
        context.globalAlpha = patchAlpha;
        context.fillStyle = patchColor;
        context.fill();
      }
    }
  }

  for (let index = 0; index < 3200; index += 1) {
    const x = random() * size;
    const y = random() * size;
    const detailSize = 1 + random() * 2;
    context.globalAlpha = 0.08 + random() * 0.14;
    context.fillStyle = marks[Math.floor(random() * marks.length)];
    if (surface === "grass") {
      const angle = random() * Math.PI * 2;
      const length = 2 + random() * 5;
      context.strokeStyle = context.fillStyle;
      context.lineWidth = 0.6 + random() * 0.6;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      context.stroke();
    } else {
      context.fillRect(x, y, detailSize, detailSize);
    }
  }
  context.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
  return texture;
}

function getTrackDistance(track, x, z) {
  let minimum = Infinity;
  for (let index = 0; index < track.points.length; index += 1) {
    const start = track.points[index];
    const end = track.points[(index + 1) % track.points.length];
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const fraction = Math.max(0, Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / (dx * dx + dz * dz)));
    minimum = Math.min(minimum, Math.hypot(x - start[0] - dx * fraction, z - start[1] - dz * fraction));
  }
  return minimum;
}

function drawTrackCards(tracks) {
  trackData = tracks;
  for (const card of document.querySelectorAll(".track-card")) {
    const track = tracks[card.dataset.trackId];
    if (!track) continue;
    const svg = card.querySelector(".track-silhouette");
    const [minX, maxX] = [
      Math.min(...track.points.map((point) => point[0])),
      Math.max(...track.points.map((point) => point[0])),
    ];
    const [minZ, maxZ] = [
      Math.min(...track.points.map((point) => point[1])),
      Math.max(...track.points.map((point) => point[1])),
    ];
    const padding = 8;
    const scale = Math.min(
      (140 - padding * 2) / Math.max(1, maxX - minX),
      (70 - padding * 2) / Math.max(1, maxZ - minZ)
    );
    const offsetX = (140 - (maxX - minX) * scale) / 2;
    const offsetY = (70 - (maxZ - minZ) * scale) / 2;
    const route = track.points.map(([x, z], index) => (
      `${index === 0 ? "M" : "L"}${(offsetX + (x - minX) * scale).toFixed(1)},${(70 - offsetY - (z - minZ) * scale).toFixed(1)}`
    )).join(" ") + " Z";
    for (const className of ["track-outline", "track-route"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", className);
      path.setAttribute("d", route);
      svg.appendChild(path);
    }
    card.querySelector(".track-card-meta b").textContent = "3 VUELTAS";
    card.querySelector(".track-card-meta span").textContent = `${track.style.toUpperCase()} · ${track.width.toFixed(1)} m`;
    card.setAttribute(
      "aria-label",
      `${track.name}, circuito ${track.style.toLowerCase()}, ${track.width.toFixed(1)} metros de ancho, tres vueltas`
    );
  }
  selectTrack(document.querySelector("#track-select").value);
}

function selectTrack(trackId) {
  const track = trackData?.[trackId];
  if (!track) return;
  document.querySelector("#track-select").value = trackId;
  document.querySelectorAll(".track-card").forEach((card) => {
    const selected = card.dataset.trackId === trackId;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  });
  document.querySelector("#track-selection-status").textContent = `${track.name.toUpperCase()} · ${track.style.toUpperCase()}`;
}

function addCircuitDecoration(track) {
  const limits = track.bounds;
  const buildingsData = [];
  const treeData = [];
  for (let x = -limits + 8; x < limits; x += 13) {
    for (let z = -limits + 8; z < limits; z += 13) {
      if (getTrackDistance(track, x, z) < track.width / 2 + 17) continue;
      const seed = Math.abs(Math.round(x * 13 + z * 7));
      if (seed % 4 === 0) {
        treeData.push({ x, z, height: 2.8 + (seed % 4) * 0.4 });
      } else {
        buildingsData.push({
          x,
          z,
          width: 5 + seed % 3,
          depth: 5 + Math.floor(seed / 3) % 3,
          height: 3 + seed % 7,
        });
      }
    }
  }

  if (buildingsData.length) {
    const buildings = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: "#d7c6a9", flatShading: true, roughness: 0.92 }),
      buildingsData.length
    );
    const windows = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 0.08),
      new THREE.MeshStandardMaterial({ color: "#79b9b1", emissive: "#274847", flatShading: true }),
      buildingsData.length * 3
    );
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    let windowIndex = 0;
    buildingsData.forEach((building, index) => {
      position.set(building.x, building.height / 2, building.z);
      scale.set(building.width, building.height, building.depth);
      matrix.compose(position, rotation, scale);
      buildings.setMatrixAt(index, matrix);
      buildings.setColorAt(index, new THREE.Color(["#d7c6a9", "#c5d0ca", "#d9b8a5", "#a9b8b2"][index % 4]));
      for (let floor = 1; floor <= 3; floor += 1) {
        position.set(
          building.x + (floor - 2) * building.width * 0.24,
          Math.min(building.height - 0.5, floor * building.height / 4),
          building.z + building.depth / 2 + 0.045
        );
        scale.set(0.52, 0.5, 1);
        matrix.compose(position, rotation, scale);
        windows.setMatrixAt(windowIndex, matrix);
        windows.setColorAt(windowIndex, new THREE.Color(floor % 2 ? "#96c8c0" : "#dfc788"));
        windowIndex += 1;
      }
    });
    buildings.instanceMatrix.needsUpdate = true;
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
    windows.count = windowIndex;
    windows.instanceMatrix.needsUpdate = true;
    if (windows.instanceColor) windows.instanceColor.needsUpdate = true;
    buildings.castShadow = true;
    buildings.receiveShadow = true;
    scene.add(buildings, windows);
  }

  if (treeData.length) {
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.18, 0.28, 1, 6),
      new THREE.MeshStandardMaterial({ color: "#70513a", flatShading: true }),
      treeData.length
    );
    const crowns = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.05, 2.1, 6),
      new THREE.MeshStandardMaterial({ color: "#356f50", flatShading: true }),
      treeData.length
    );
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    treeData.forEach((tree, index) => {
      position.set(tree.x, tree.height * 0.18, tree.z);
      scale.set(1, tree.height * 0.4, 1);
      matrix.compose(position, rotation, scale);
      trunks.setMatrixAt(index, matrix);
      position.set(tree.x, tree.height * 0.68, tree.z);
      scale.set(1, tree.height / 2.1, 1);
      matrix.compose(position, rotation, scale);
      crowns.setMatrixAt(index, matrix);
      crowns.setColorAt(index, new THREE.Color(index % 2 ? "#397b55" : "#2f694d"));
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    trunks.castShadow = true;
    crowns.castShadow = true;
    scene.add(trunks, crowns);
  }

  const standIndices = [4, 16, 29, 41];
  for (const index of standIndices) {
    const point = track.points[index % track.points.length];
    const next = track.points[(index + 1) % track.points.length];
    const dx = next[0] - point[0];
    const dz = next[1] - point[1];
    const length = Math.hypot(dx, dz) || 1;
    const normalX = dz / length;
    const normalZ = -dx / length;
    const side = index % 2 === 0 ? 1 : -1;
    const stand = new THREE.Group();
    stand.position.set((point[0] + next[0]) / 2, 0, (point[1] + next[1]) / 2);
    stand.rotation.y = Math.atan2(-dz, dx);
    let hasSeats = false;
    for (let row = 0; row < 3; row += 1) {
      const offset = track.width / 2 + 3 + row * 0.75;
      const candidateX = stand.position.x + normalX * side * offset;
      const candidateZ = stand.position.z + normalZ * side * offset;
      const halfLength = Math.min(length * 0.8, 8) / 2;
      const tangentX = dx / length;
      const tangentZ = dz / length;
      const clearOfTrack = [-1, 0, 1].every((sample) => (
        getTrackDistance(
          track,
          candidateX + tangentX * halfLength * sample,
          candidateZ + tangentZ * halfLength * sample
        ) >= track.width / 2 + 1.1
      ));
      if (!clearOfTrack) continue;
      const seats = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(length * 0.8, 8), 0.42, 1.15),
        new THREE.MeshStandardMaterial({ color: row % 2 ? "#d96d62" : "#e8d9ae", flatShading: true })
      );
      seats.position.set(-side * offset, 0.55 + row * 0.42, 0);
      stand.add(seats);
      hasSeats = true;
    }
    if (!hasSeats) continue;
    stand.traverse((object) => {
      if (object.isMesh) object.castShadow = true;
    });
    scene.add(stand);
  }
}

function createTrack(track) {
  scene.background = new THREE.Color("#a8d7dc");
  scene.fog = new THREE.Fog("#a8d7dc", 145, 300);
  const ambient = new THREE.HemisphereLight("#e3f6e8", "#536e5c", 1.55);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight("#fff5d5", 3.1);
  sun.position.set(-38, 57, -22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -110;
  sun.shadow.camera.right = 110;
  sun.shadow.camera.top = 110;
  sun.shadow.camera.bottom = -110;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 240;
  sun.shadow.bias = -0.00015;
  scene.add(sun);

  const grassTexture = makeTexture("#72b982", ["#4fa676", "#97cb79", "#b2d27e", "#8dc988"], 28, 20, "grass");
  const mapSize = track.bounds * 2 + 20;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(mapSize, mapSize), new THREE.MeshStandardMaterial({ map: grassTexture, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.15;
  ground.receiveShadow = true;
  scene.add(ground);

  const edges = globalThis.RaceTrackGeometry.getTrackEdges(track);
  const vertices = [];
  const uvs = [];
  const indices = [];
  for (let index = 0; index < track.points.length; index += 1) {
    const edge = edges[index];
    vertices.push(edge.left[0], 0.025, edge.left[1], edge.right[0], 0.025, edge.right[1]);
    uvs.push(0, index / 4, 1, index / 4);
    const next = (index + 1) % track.points.length;
    indices.push(index * 2, next * 2, index * 2 + 1, index * 2 + 1, next * 2, next * 2 + 1);
  }
  const asphalt = makeTexture("#565f61", ["#70797a", "#40494c", "#838887", "#646e70"], 91, 8, "asphalt");
  const roadGeometry = new THREE.BufferGeometry();
  roadGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  roadGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  roadGeometry.setIndex(indices);
  roadGeometry.computeVertexNormals();
  const road = new THREE.Mesh(roadGeometry, new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95, side: THREE.DoubleSide }));
  road.receiveShadow = true;
  scene.add(road);

  const centerLinePoints = track.points.map((point) => new THREE.Vector3(point[0], 0.075, point[1]));
  const centerLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([...centerLinePoints, centerLinePoints[0]]),
    new THREE.LineDashedMaterial({ color: "#d6dfcd", dashSize: 1.5, gapSize: 1.7, transparent: true, opacity: 0.48 })
  );
  centerLine.computeLineDistances();
  scene.add(centerLine);

  const kerbs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.09, 0.72),
    new THREE.MeshStandardMaterial({ color: "#f6efe0", roughness: 0.78 }),
    track.points.length * 2
  );
  const kerbMatrix = new THREE.Matrix4();
  const kerbPosition = new THREE.Vector3();
  const kerbRotation = new THREE.Quaternion();
  const kerbScale = new THREE.Vector3();
  let kerbIndex = 0;
  for (const side of ["left", "right"]) {
    for (let index = 0; index < edges.length; index += 1) {
      const edgePoint = edges[index][side];
      const nextEdgePoint = edges[(index + 1) % edges.length][side];
      const dx = nextEdgePoint[0] - edgePoint[0];
      const dz = nextEdgePoint[1] - edgePoint[1];
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      const centerX = (track.points[index][0] + track.points[(index + 1) % track.points.length][0]) / 2;
      const centerZ = (track.points[index][1] + track.points[(index + 1) % track.points.length][1]) / 2;
      const inwardX = centerX - (edgePoint[0] + nextEdgePoint[0]) / 2;
      const inwardZ = centerZ - (edgePoint[1] + nextEdgePoint[1]) / 2;
      const inwardLength = Math.hypot(inwardX, inwardZ) || 1;
      kerbPosition.set(
        (edgePoint[0] + nextEdgePoint[0]) / 2 + inwardX / inwardLength * 0.32,
        0.105,
        (edgePoint[1] + nextEdgePoint[1]) / 2 + inwardZ / inwardLength * 0.32
      );
      kerbRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dz, dx));
      kerbScale.set(length, 1, 1);
      kerbMatrix.compose(kerbPosition, kerbRotation, kerbScale);
      kerbs.setMatrixAt(kerbIndex, kerbMatrix);
      kerbs.setColorAt(kerbIndex, new THREE.Color(index % 2 ? "#f5eee0" : "#df5f57"));
      kerbIndex += 1;
    }
  }
  kerbs.count = kerbIndex;
  kerbs.instanceMatrix.needsUpdate = true;
  if (kerbs.instanceColor) kerbs.instanceColor.needsUpdate = true;
  kerbs.receiveShadow = true;
  scene.add(kerbs);

  for (const [edgeName, color] of [["left", "#f7f0dc"], ["right", "#f7f0dc"]]) {
    const linePoints = edges.map((edge) => new THREE.Vector3(edge[edgeName][0], 0.1, edge[edgeName][1]));
    scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(linePoints), new THREE.LineBasicMaterial({ color })));
  }
  const barriers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 0.5),
    new THREE.MeshStandardMaterial({ color: "#f5eee0", flatShading: true }),
    track.points.length * 2
  );
  const barrierRails = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.13, 0.64),
    new THREE.MeshStandardMaterial({ color: "#e7eee2", metalness: 0.22, roughness: 0.55 }),
    track.points.length * 2
  );
  const barrierMatrix = new THREE.Matrix4();
  const barrierPosition = new THREE.Vector3();
  const barrierRotation = new THREE.Quaternion();
  const barrierScale = new THREE.Vector3();
  let barrierIndex = 0;
  for (const edgeName of ["left", "right"]) {
    for (let index = 0; index < edges.length; index += 1) {
      const startEdge = edges[index][edgeName];
      const endEdge = edges[(index + 1) % edges.length][edgeName];
      const dx = endEdge[0] - startEdge[0];
      const dz = endEdge[1] - startEdge[1];
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      barrierPosition.set((startEdge[0] + endEdge[0]) / 2, 0.62, (startEdge[1] + endEdge[1]) / 2);
      barrierRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dz, dx));
      barrierScale.set(length, 1.24, 1);
      barrierMatrix.compose(barrierPosition, barrierRotation, barrierScale);
      barriers.setMatrixAt(barrierIndex, barrierMatrix);
      barriers.setColorAt(barrierIndex, new THREE.Color(barrierIndex % 2 ? "#f5eee0" : "#e87662"));
      barrierPosition.y = 1.28;
      barrierScale.y = 1;
      barrierScale.z = 0.7;
      barrierMatrix.compose(barrierPosition, barrierRotation, barrierScale);
      barrierRails.setMatrixAt(barrierIndex, barrierMatrix);
      barrierRails.setColorAt(barrierIndex, new THREE.Color(barrierIndex % 2 ? "#e7eee2" : "#f3ca69"));
      barrierPosition.y = 0.62;
      barrierScale.y = 1.24;
      barrierScale.z = 1;
      barrierIndex += 1;
    }
  }
  barriers.count = barrierIndex;
  barriers.instanceMatrix.needsUpdate = true;
  if (barriers.instanceColor) barriers.instanceColor.needsUpdate = true;
  barriers.castShadow = true;
  barriers.receiveShadow = true;
  barrierRails.count = barrierIndex;
  barrierRails.instanceMatrix.needsUpdate = true;
  if (barrierRails.instanceColor) barrierRails.instanceColor.needsUpdate = true;
  barrierRails.castShadow = true;
  scene.add(barriers, barrierRails);

  const limits = track.bounds;
  const wallMaterial = new THREE.MeshStandardMaterial({ color: "#e87662", flatShading: true });
  for (const [x, z, width, depth] of [
    [0, -limits, mapSize, 0.8], [0, limits, mapSize, 0.8],
    [-limits, 0, 0.8, mapSize], [limits, 0, 0.8, mapSize],
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, 1.5, depth), wallMaterial);
    wall.position.set(x, 0.75, z);
    wall.castShadow = true;
    scene.add(wall);
  }

  addCircuitDecoration(track);

  const start = track.points[0];
  const next = track.points[1];
  const tangentX = next[0] - start[0];
  const tangentZ = next[1] - start[1];
  const tangentLength = Math.hypot(tangentX, tangentZ);
  const normalX = -tangentZ / tangentLength;
  const normalZ = tangentX / tangentLength;
  const startLine = new THREE.Group();
  const tileMaterialA = new THREE.MeshStandardMaterial({ color: "#fff8e4", flatShading: true });
  const tileMaterialB = new THREE.MeshStandardMaterial({ color: "#34474a", flatShading: true });
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 14; col += 1) {
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.07, 0.7),
        (row + col) % 2 ? tileMaterialA : tileMaterialB
      );
      tile.position.set(
        start[0] + tangentX / tangentLength * (row - 0.5) * 0.7 + normalX * (col - 6.5) * track.width / 14,
        0.1,
        start[1] + tangentZ / tangentLength * (row - 0.5) * 0.7 + normalZ * (col - 6.5) * track.width / 14
      );
      startLine.add(tile);
    }
  }
  scene.add(startLine);

  const gridMarks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.1, 0.055, 2.4),
    new THREE.MeshStandardMaterial({ color: "#e9eddf", roughness: 0.9 }),
    8
  );
  const gridMatrix = new THREE.Matrix4();
  const gridPosition = new THREE.Vector3();
  const gridRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.atan2(-tangentX, -tangentZ)
  );
  const gridScale = new THREE.Vector3(1, 1, 1);
  for (let index = 0; index < 8; index += 1) {
    const row = Math.floor(index / 2);
    const lane = index % 2 === 0 ? -1 : 1;
    const lateral = lane * Math.min(track.width / 4, 2.2);
    const distance = 4 + row * 4.5;
    gridPosition.set(
      start[0] - tangentX / tangentLength * distance + normalX * lateral,
      0.09,
      start[1] - tangentZ / tangentLength * distance + normalZ * lateral
    );
    gridMatrix.compose(gridPosition, gridRotation, gridScale);
    gridMarks.setMatrixAt(index, gridMatrix);
  }
  gridMarks.instanceMatrix.needsUpdate = true;
  gridMarks.receiveShadow = true;
  scene.add(gridMarks);

  const finishGate = new THREE.Group();
  const gateMaterial = new THREE.MeshStandardMaterial({ color: "#f1ead4", metalness: 0.12, roughness: 0.55 });
  const pillarGeometry = new THREE.BoxGeometry(0.55, 3.8, 0.65);
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(pillarGeometry, gateMaterial);
    pillar.position.set(start[0] + normalX * side * (track.width / 2 + 0.4), 1.9, start[1] + normalZ * side * (track.width / 2 + 0.4));
    pillar.castShadow = true;
    finishGate.add(pillar);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(track.width + 1.2, 0.62, 0.72), gateMaterial);
  beam.position.set(start[0], 3.65, start[1]);
  beam.rotation.y = Math.atan2(-normalZ, normalX);
  beam.castShadow = true;
  finishGate.add(beam);
  const finishSign = new THREE.Mesh(
    new THREE.BoxGeometry(track.width * 0.58, 0.44, 0.12),
    new THREE.MeshStandardMaterial({ color: "#17383a", emissive: "#0f4640", roughness: 0.4 })
  );
  finishSign.position.set(start[0], 3.65, start[1] - tangentZ / tangentLength * 0.45);
  finishSign.rotation.y = beam.rotation.y;
  finishGate.add(finishSign);
  scene.add(finishGate);
}

function getCatalogItem(itemId) {
  return catalogData?.items.find((item) => item.id === itemId) || null;
}

function createCamoTexture(baseColor, pattern, accent) {
  if (!pattern || pattern === "none") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  context.fillStyle = baseColor;
  context.fillRect(0, 0, 256, 256);
  context.fillStyle = accent;
  context.strokeStyle = accent;
  if (pattern === "stripes") {
    context.globalAlpha = 0.85;
    context.lineWidth = 28;
    for (let x = -256; x < 512; x += 78) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + 256, 256);
      context.stroke();
    }
  } else if (pattern === "camo") {
    let seed = 41;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    context.globalAlpha = 0.55;
    for (let index = 0; index < 38; index += 1) {
      const x = random() * 256;
      const y = random() * 256;
      context.beginPath();
      context.ellipse(x, y, 12 + random() * 22, 7 + random() * 15, random() * Math.PI, 0, Math.PI * 2);
      context.fill();
    }
  } else if (pattern === "carbon") {
    context.globalAlpha = 0.5;
    context.lineWidth = 4;
    for (let x = -256; x < 512; x += 24) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + 256, 256);
      context.stroke();
      context.beginPath();
      context.moveTo(x + 12, 0);
      context.lineTo(x - 244, 256);
      context.stroke();
    }
  } else if (pattern === "neon") {
    context.globalAlpha = 0.9;
    context.lineWidth = 7;
    for (let y = 28; y < 256; y += 64) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(256, y - 28);
      context.stroke();
    }
  } else if (pattern === "checker") {
    context.globalAlpha = 0.92;
    for (let y = 0; y < 256; y += 32) {
      for (let x = 0; x < 256; x += 32) {
        if ((x + y) % 64 === 0) context.fillRect(x, y, 32, 32);
      }
    }
  }
  context.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
  return texture;
}

function createCar(color, cosmetics = {}) {
  const car = new THREE.Group();
  const camo = getCatalogItem(cosmetics.camo);
  const paintStyle = getCatalogItem(cosmetics.color);
  const wheelStyle = getCatalogItem(cosmetics.wheels);
  const helmetStyle = getCatalogItem(cosmetics.helmet);
  const spoilerStyle = getCatalogItem(cosmetics.spoiler);
  const trailStyle = getCatalogItem(cosmetics.trail);
  const bodyTexture = createCamoTexture(color, camo?.pattern, camo?.accent || "#f4f0dc");
  const paint = new THREE.MeshStandardMaterial({
    color: bodyTexture ? "#ffffff" : color,
    map: bodyTexture,
    roughness: 0.34,
    metalness: paintStyle?.finish === "metallic" ? 0.58 : 0.04,
    flatShading: true,
  });
  const dark = new THREE.MeshStandardMaterial({ color: "#17292b", roughness: 0.75, flatShading: true });
  const glass = new THREE.MeshPhysicalMaterial({
    color: "#6d9e9d",
    roughness: 0.16,
    metalness: 0.14,
    transparent: true,
    opacity: 0.72,
    clearcoat: 0.8,
  });
  const trim = new THREE.MeshStandardMaterial({ color: "#101a1d", metalness: 0.28, roughness: 0.58 });
  const lightFront = new THREE.MeshStandardMaterial({ color: "#fff2bc", emissive: "#ffd85f", emissiveIntensity: 1.4 });
  const lightRear = new THREE.MeshStandardMaterial({ color: "#ff5b50", emissive: "#af1719", emissiveIntensity: 1.1 });
  const addPart = (geometry, material, position, rotation = null) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    car.add(mesh);
    return mesh;
  };

  addPart(new THREE.BoxGeometry(1.82, 0.42, 3.8), paint, [0, 0.62, 0.02]);
  addPart(new THREE.BoxGeometry(1.96, 0.28, 2.45), paint, [0, 0.82, 0.22]);
  addPart(new THREE.BoxGeometry(1.46, 0.2, 1.27), paint, [0, 0.77, -1.37]);
  addPart(new THREE.BoxGeometry(1.9, 0.11, 0.58), trim, [0, 0.48, -1.88]);
  addPart(new THREE.BoxGeometry(1.9, 0.13, 0.42), trim, [0, 0.48, 1.9]);
  addPart(new THREE.BoxGeometry(1.25, 0.47, 1.27), dark, [0, 1.02, 0.1]);
  addPart(new THREE.BoxGeometry(1.13, 0.39, 0.76), glass, [0, 1.16, -0.02], [-0.18, 0, 0]);
  addPart(new THREE.BoxGeometry(0.95, 0.31, 0.52), glass, [0, 1.1, 0.62], [0.24, 0, 0]);
  addPart(new THREE.SphereGeometry(0.31, 10, 8), new THREE.MeshStandardMaterial({ color: "#f1c79f", flatShading: true }), [0, 1.39, 0.14]);
  const helmetColor = helmetStyle?.color || color;
  addPart(new THREE.SphereGeometry(0.42, 12, 9), new THREE.MeshStandardMaterial({ color: helmetColor, metalness: 0.18, roughness: 0.32, flatShading: true }), [0, 1.7, 0.12]);
  addPart(new THREE.BoxGeometry(0.56, 0.19, 0.08), new THREE.MeshStandardMaterial({ color: helmetStyle?.visor || "#193d45", metalness: 0.38, roughness: 0.22 }), [0, 1.7, -0.27]);
  addPart(new THREE.BoxGeometry(0.16, 0.14, 0.82), trim, [-0.89, 0.94, -0.55]);
  addPart(new THREE.BoxGeometry(0.16, 0.14, 0.82), trim, [0.89, 0.94, -0.55]);
  for (const side of [-1, 1]) {
    addPart(new THREE.BoxGeometry(0.26, 0.14, 0.22), paint, [side * 1.02, 1.03, -0.74]);
    addPart(new THREE.BoxGeometry(0.22, 0.09, 0.12), lightFront, [side * 0.68, 0.76, -1.99]);
    addPart(new THREE.BoxGeometry(0.28, 0.1, 0.11), lightRear, [side * 0.64, 0.72, 1.96]);
  }

  const wheelGroups = [];
  const frontWheelGroups = [];
  const tireMaterial = new THREE.MeshStandardMaterial({
    color: wheelStyle?.style === "offroad" ? "#292a27" : "#171d1e",
    roughness: 0.94,
    flatShading: true,
  });
  const rimMaterial = new THREE.MeshStandardMaterial({
    color: wheelStyle?.color || "#c5d0ca",
    metalness: wheelStyle?.style === "gold" ? 0.82 : 0.68,
    roughness: wheelStyle?.style === "neon" ? 0.22 : 0.38,
    emissive: wheelStyle?.style === "neon" ? wheelStyle.color : "#000000",
    emissiveIntensity: wheelStyle?.style === "neon" ? 0.45 : 0,
  });
  for (const x of [-1.03, 1.03]) {
    for (const z of [-1.19, 1.2]) {
      const wheel = new THREE.Group();
      const radius = wheelStyle?.style === "offroad" ? 0.41 : 0.37;
      wheel.userData.radius = radius;
      const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 0.3, wheelStyle?.style === "offroad" ? 10 : 14),
        tireMaterial
      );
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      wheel.add(tire);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.315, 12), rimMaterial);
      rim.rotation.z = Math.PI / 2;
      rim.castShadow = true;
      wheel.add(rim);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.34, 10), trim);
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      for (let spoke = 0; spoke < (wheelStyle?.style === "sport" ? 8 : 5); spoke += 1) {
        const angle = spoke / (wheelStyle?.style === "sport" ? 8 : 5) * Math.PI * 2;
        const spokeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.34), rimMaterial);
        spokeMesh.position.set(0, Math.cos(angle) * 0.12, Math.sin(angle) * 0.12);
        spokeMesh.rotation.x = angle;
        wheel.add(spokeMesh);
      }
      if (z < 0) {
        const steeringPivot = new THREE.Group();
        steeringPivot.position.set(x, 0.4, z);
        steeringPivot.add(wheel);
        car.add(steeringPivot);
        frontWheelGroups.push(steeringPivot);
      } else {
        wheel.position.set(x, 0.4, z);
        car.add(wheel);
      }
      wheelGroups.push(wheel);
    }
  }

  const spoilerWidth = spoilerStyle?.style === "gt" ? 2.4 : spoilerStyle?.style === "double" ? 2.1 : 1.85;
  const spoilerHeight = spoilerStyle?.style === "low" ? 0.99 : 1.35;
  addPart(new THREE.BoxGeometry(0.11, 0.44, 0.12), trim, [-0.62, spoilerHeight - 0.16, 1.43]);
  addPart(new THREE.BoxGeometry(0.11, 0.44, 0.12), trim, [0.62, spoilerHeight - 0.16, 1.43]);
  addPart(new THREE.BoxGeometry(spoilerWidth, 0.14, 0.34), paint, [0, spoilerHeight, 1.48]);
  if (spoilerStyle?.style === "double") {
    addPart(new THREE.BoxGeometry(spoilerWidth * 0.82, 0.1, 0.3), paint, [0, spoilerHeight - 0.29, 1.51]);
  }

  const trailColor = trailStyle?.color || "#e7f2eb";
  const trailGeometry = trailStyle?.style === "flame"
    ? new THREE.ConeGeometry(0.13, 0.52, 6)
    : trailStyle?.style === "sparks"
      ? new THREE.TetrahedronGeometry(0.18, 0)
      : trailStyle?.style === "neon"
        ? new THREE.BoxGeometry(0.08, 0.08, 0.42)
        : new THREE.SphereGeometry(0.15, 7, 5);
  const trailGroup = new THREE.Group();
  for (let index = 0; index < 4; index += 1) {
    const particle = new THREE.Mesh(
      trailGeometry,
      new THREE.MeshBasicMaterial({ color: trailColor, transparent: true, opacity: 0.45 - index * 0.07 })
    );
    particle.position.set((index % 2 ? 1 : -1) * 0.14, 0.5 - index * 0.03, 2.08 + index * 0.34);
    if (trailStyle?.style === "flame") particle.rotation.x = Math.PI / 2;
    trailGroup.add(particle);
  }
  trailGroup.visible = trailStyle?.style !== "none";
  car.add(trailGroup);
  car.userData.wheelGroups = wheelGroups;
  car.userData.frontWheelGroups = frontWheelGroups;
  car.userData.trailGroup = trailGroup;
  car.userData.trailStyle = trailStyle?.style || "none";
  car.userData.brakeLightMaterial = lightRear;
  car.userData.cosmeticSignature = cosmeticSignature(cosmetics);
  car.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return car;
}

function cosmeticSignature(cosmetics = {}) {
  return cosmeticCategories.map((category) => cosmetics[category] || "").join("|");
}

function disposeCar(mesh) {
  mesh.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.map?.dispose();
      material.dispose();
    }
  });
}

function getEquippedCosmetics() {
  return { ...(accountProfile?.equipped || catalogData?.defaults || {}) };
}

function getCosmeticColor(cosmetics) {
  return getCatalogItem(cosmetics.color)?.color || "#30d6c1";
}

function setPreviewAppearance(containerId, cosmetics, label) {
  const preview = previewViews.get(containerId);
  if (!preview) return;
  if (preview.car) {
    preview.scene.remove(preview.car);
    disposeCar(preview.car);
  }
  preview.car = createCar(getCosmeticColor(cosmetics), cosmetics);
  preview.car.rotation.y = Math.PI / 4;
  preview.scene.add(preview.car);
  const labelElement = document.querySelector(`#${containerId}-label`);
  if (labelElement) labelElement.textContent = label;
}

function initializePreview(containerId) {
  if (previewViews.has(containerId) || !catalogData) return;
  const container = document.getElementById(containerId);
  if (!container) return;
  const previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  previewRenderer.shadowMap.enabled = true;
  previewRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
  previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  previewRenderer.toneMappingExposure = 1.12;
  container.appendChild(previewRenderer.domElement);
  const previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color("#17383a");
  previewScene.add(new THREE.HemisphereLight("#e3f6e8", "#334c49", 2));
  const keyLight = new THREE.DirectionalLight("#fff0cf", 3);
  keyLight.position.set(-5, 9, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(512, 512);
  previewScene.add(keyLight);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(5.5, 48),
    new THREE.MeshStandardMaterial({ color: "#254345", roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.08;
  floor.receiveShadow = true;
  previewScene.add(floor);
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(3.05, 3.25, 0.14, 48),
    new THREE.MeshStandardMaterial({ color: "#193b3c", metalness: 0.35, roughness: 0.52, emissive: "#092524" })
  );
  platform.position.y = -0.015;
  platform.receiveShadow = true;
  platform.castShadow = true;
  previewScene.add(platform);
  const platformRing = new THREE.Mesh(
    new THREE.RingGeometry(2.55, 2.68, 64),
    new THREE.MeshBasicMaterial({ color: "#30d6c1", side: THREE.DoubleSide })
  );
  platformRing.rotation.x = -Math.PI / 2;
  platformRing.position.y = 0.06;
  previewScene.add(platformRing);
  const rimLight = new THREE.PointLight("#30d6c1", 22, 8);
  rimLight.position.set(-2.8, 1.2, -1.6);
  previewScene.add(rimLight);
  const warmLight = new THREE.PointLight("#ffb94b", 12, 7);
  warmLight.position.set(3.2, 0.8, 2.1);
  previewScene.add(warmLight);
  const previewCamera = new THREE.PerspectiveCamera(39, 1, 0.1, 50);
  previewCamera.position.set(5.1, 3.5, 6.4);
  previewCamera.lookAt(0, 0.75, 0);
  const preview = {
    container,
    renderer: previewRenderer,
    scene: previewScene,
    camera: previewCamera,
    car: null,
    dragging: false,
    lastPointerX: 0,
  };
  previewViews.set(containerId, preview);
  previewRenderer.domElement.addEventListener("pointerdown", (event) => {
    preview.dragging = true;
    preview.lastPointerX = event.clientX;
    previewRenderer.domElement.setPointerCapture(event.pointerId);
  });
  previewRenderer.domElement.addEventListener("pointermove", (event) => {
    if (!preview.dragging || !preview.car) return;
    preview.car.rotation.y += (event.clientX - preview.lastPointerX) * 0.012;
    preview.lastPointerX = event.clientX;
  });
  previewRenderer.domElement.addEventListener("pointerup", () => { preview.dragging = false; });
  previewRenderer.domElement.addEventListener("pointercancel", () => { preview.dragging = false; });
  resizePreviewViews();
  const cosmetics = getEquippedCosmetics();
  const initialLabel = accountProfile ? `${accountProfile.username} · equipado` : "Configuración base gratuita";
  preview.car = createCar(getCosmeticColor(cosmetics), cosmetics);
  preview.car.rotation.y = Math.PI / 4;
  previewScene.add(preview.car);
  const label = document.querySelector(`#${containerId}-label`);
  if (label) label.textContent = initialLabel;
  if (!renderLoopStarted) {
    renderLoopStarted = true;
    renderFrame();
  }
}

function resizePreviewViews() {
  for (const [containerId, preview] of previewViews) {
    const container = document.getElementById(containerId);
    if (!container) continue;
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    preview.renderer.setSize(width, height, false);
    preview.camera.aspect = width / height;
    preview.camera.updateProjectionMatrix();
  }
}

function resizeRenderer() {
  const width = Math.max(gameView.clientWidth, 1);
  const height = Math.max(gameView.clientHeight, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  resizePreviewViews();
}

function shortestAngle(from, to) {
  let difference = to - from;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
}

function renderFrame() {
  requestAnimationFrame(renderFrame);
  const dt = Math.min(clock.getDelta(), 0.06);
  for (const carView of carViews.values()) {
    carView.mesh.position.lerp(carView.targetPosition, Math.min(1, dt * 8));
    const yawDifference = shortestAngle(carView.mesh.rotation.y, carView.targetYaw);
    carView.mesh.rotation.y += yawDifference * Math.min(1, dt * 8);
    for (const wheel of carView.mesh.userData.wheelGroups || []) {
      wheel.rotation.x -= carView.speed * dt / (wheel.userData.radius || 0.37);
    }
    for (const steeringPivot of carView.mesh.userData.frontWheelGroups || []) {
      steeringPivot.rotation.y = -carView.steering * 0.32;
    }
    carView.mesh.userData.brakeLightMaterial.emissiveIntensity = carView.braking ? 3.6 : 1.1;
    const trail = carView.mesh.userData.trailGroup;
    if (trail) {
      trail.visible = carView.accelerating && carView.mesh.userData.trailStyle !== "none";
      if (trail.visible) {
        trail.children.forEach((particle, index) => {
          particle.position.z = 2.08 + index * 0.34 + (performance.now() / 380 + index * 0.45) % 0.45;
          particle.scale.setScalar(0.85 + ((performance.now() / 250 + index) % 3) * 0.22);
        });
      }
    }
  }

  for (const preview of previewViews.values()) {
    if (!preview.container.getClientRects().length) continue;
    if (!preview.dragging) preview.car.rotation.y += dt * 0.42;
    for (const wheel of preview.car.userData.wheelGroups || []) wheel.rotation.x -= dt * 0.8;
    const previewTrail = preview.car.userData.trailGroup;
    if (previewTrail?.visible) {
      previewTrail.children.forEach((particle, index) => {
        particle.position.z = 2.08 + index * 0.34 + (performance.now() / 380 + index * 0.45) % 0.45;
        particle.scale.setScalar(0.85 + ((performance.now() / 250 + index) % 3) * 0.22);
      });
    }
    preview.renderer.render(preview.scene, preview.camera);
  }

  const playerCar = playerId ? carViews.get(playerId) : null;
  if (playerCar) {
    const cameraTarget = playerCar.mesh.localToWorld(new THREE.Vector3(0, 5.2, 10));
    camera.position.lerp(cameraTarget, Math.min(1, dt * 2.7));
    camera.lookAt(playerCar.mesh.position.x, 1.2, playerCar.mesh.position.z);
  }
  updateRaceClock(performance.now());
  if (sceneReady && !raceScreen.classList.contains("is-hidden")) renderer.render(scene, camera);
}

function initializeScene(track) {
  if (sceneReady && sceneTrackId === track.id) return;
  for (const carView of carViews.values()) disposeCar(carView.mesh);
  scene.clear();
  carViews.clear();
  sceneReady = true;
  sceneTrackId = track.id;
  createTrack(track);
  resizeRenderer();
  if (!renderLoopStarted) {
    renderLoopStarted = true;
    renderFrame();
  }
}

function drawMinimap(state) {
  const context = minimap.getContext("2d");
  if (!context || !state.track?.points?.length) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = minimap.clientWidth || 142;
  const height = minimap.clientHeight || 142;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (minimap.width !== pixelWidth || minimap.height !== pixelHeight) {
    minimap.width = pixelWidth;
    minimap.height = pixelHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const points = state.track.points;
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minZ = Math.min(...points.map((point) => point[1]));
  const maxZ = Math.max(...points.map((point) => point[1]));
  const padding = 13;
  const scale = Math.min(
    (width - padding * 2) / Math.max(1, maxX - minX),
    (height - padding * 2) / Math.max(1, maxZ - minZ)
  );
  const toCanvas = ([x, z]) => [
    (width - (maxX - minX) * scale) / 2 + (x - minX) * scale,
    height - ((height - (maxZ - minZ) * scale) / 2 + (z - minZ) * scale),
  ];

  context.beginPath();
  points.forEach((point, index) => {
    const [x, y] = toCanvas(point);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.closePath();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(5, 17, 19, .9)";
  context.lineWidth = Math.max(7, state.track.width * scale + 4);
  context.stroke();
  context.strokeStyle = "#30d6c1";
  context.lineWidth = Math.max(3, state.track.width * scale);
  context.stroke();
  context.strokeStyle = "rgba(236, 244, 224, .65)";
  context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.stroke();
  context.setLineDash([]);

  for (const car of state.cars) {
    const [x, y] = toCanvas([car.x, car.z]);
    context.beginPath();
    context.arc(x, y, car.id === playerId ? 5 : 3.2, 0, Math.PI * 2);
    if (car.id === playerId) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.shadowColor = "#30d6c1";
      context.shadowBlur = 9;
      context.stroke();
      context.shadowBlur = 0;
    }
    context.fillStyle = car.color || "#e9f2e7";
    context.fill();
  }
}

function updateLeaderboard(cars) {
  standingsList.replaceChildren();
  for (const car of cars) {
    const row = document.createElement("li");
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(car.place).padStart(2, "0");
    const swatch = document.createElement("span");
    swatch.className = "driver-swatch";
    swatch.style.backgroundColor = car.color;
    const name = document.createElement("span");
    name.textContent = `${car.name}${car.isBot ? " · IA" : ""}`;
    const lap = document.createElement("span");
    lap.className = "driver-lap";
    if (car.finished) {
      lap.textContent = car.isFirstFinisher
        ? `🏁 ${formatRaceTime(car.finishTimeMs)}`
        : `🏁 +${(car.gapMs / 1000).toFixed(2)}`;
      lap.setAttribute("aria-label", car.isFirstFinisher ? "Ganador, tiempo final" : "Terminado, diferencia con el ganador");
      row.classList.add("is-finished");
      if (car.isFirstFinisher) row.classList.add("is-winner");
    } else {
      lap.textContent = `${Math.min(car.lap, 3)}/3`;
    }
    row.append(rank, swatch, name, lap);
    standingsList.appendChild(row);
  }
}

function formatRaceTime(milliseconds) {
  const centiseconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 10);
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = Math.floor(centiseconds / 100) % 60;
  const remainder = centiseconds % 100;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(2, "0")}`;
}

function updatePilotPanel() {
  const profile = accountProfile;
  const driverName = document.querySelector("#driver-name");
  if (profile) {
    driverName.value = profile.username;
    driverName.readOnly = true;
  } else {
    driverName.readOnly = false;
  }
  const displayName = profile?.username || driverName.value.trim() || "Piloto";
  document.querySelector("#pilot-display-name").textContent = displayName;
  document.querySelector("#pilot-initial").textContent = displayName.charAt(0).toUpperCase();
  document.querySelector("#pilot-account-status").textContent = profile ? "CUENTA ACTIVA" : "INVITADO";
  document.querySelector("#showroom-status").textContent = profile ? "LOADOUT PERSONALIZADO" : "CONFIGURACIÓN BASE";
  const stats = profile?.stats;
  document.querySelector("#pilot-points").textContent = stats ? String(stats.points) : "—";
  document.querySelector("#pilot-races").textContent = stats ? String(stats.racesPlayed) : "—";
  document.querySelector("#pilot-wins").textContent = stats ? String(stats.wins) : "—";
  document.querySelector("#pilot-podiums").textContent = stats ? String(stats.podiums) : "—";
  document.querySelector("#pilot-best-lap").textContent = Number.isFinite(stats?.bestLapMs)
    ? formatRaceTime(stats.bestLapMs)
    : "—";
}

function renderLoadoutSummary(cosmetics) {
  const summary = document.querySelector("#loadout-summary");
  summary.replaceChildren();
  for (const category of cosmeticCategories) {
    const item = getCatalogItem(cosmetics[category]);
    const chip = document.createElement("span");
    chip.className = "loadout-chip";
    chip.textContent = item?.name || categoryLabels[category];
    summary.appendChild(chip);
  }
}

async function refreshGlobalLeaderboard() {
  const list = document.querySelector("#global-leaderboard");
  try {
    const response = await fetch("/api/leaderboard");
    if (!response.ok) throw new Error("No se pudo cargar la clasificación global.");
    const drivers = await response.json();
    list.replaceChildren();
    if (!drivers.length) {
      const empty = document.createElement("li");
      empty.className = "rank-empty";
      empty.textContent = "Aún no hay pilotos clasificados.";
      list.appendChild(empty);
      return;
    }
    drivers.forEach((driver, index) => {
      const row = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "global-rank";
      rank.textContent = String(index + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "global-name";
      name.textContent = driver.username;
      const points = document.createElement("span");
      points.className = "global-points";
      points.textContent = `${driver.points} PTS`;
      const wins = document.createElement("span");
      wins.className = "global-wins";
      wins.textContent = `${driver.wins}V`;
      row.append(rank, name, points, wins);
      list.appendChild(row);
    });
  } catch (error) {
    list.replaceChildren();
    const failure = document.createElement("li");
    failure.className = "rank-empty";
    failure.textContent = error.message;
    list.appendChild(failure);
    console.warn("No se pudo actualizar la clasificación global.", error);
  }
}

async function initializeLanInvite() {
  const link = document.querySelector("#lan-url");
  const status = document.querySelector("#lan-copy-status");
  try {
    const response = await fetch("/api/info");
    if (!response.ok) throw new Error("No se pudo consultar la dirección LAN.");
    const info = await response.json();
    const address = info.lanUrls?.[0] || window.location.origin;
    link.href = address;
    link.textContent = address;
  } catch (error) {
    status.textContent = error.message;
    console.warn("No se pudo consultar la dirección de la red local.", error);
  }
}

async function copyLanAddress() {
  const link = document.querySelector("#lan-url");
  const status = document.querySelector("#lan-copy-status");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link.href);
    } else {
      const input = document.createElement("textarea");
      input.value = link.href;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("El navegador no permitió copiar el enlace.");
    }
    status.textContent = "ENLACE COPIADO";
  } catch (error) {
    status.textContent = "No se pudo copiar. Selecciona la dirección para compartirla.";
    console.warn("No se pudo copiar el enlace LAN.", error);
  }
}

function updateRaceClock(now) {
  if (now - lastClockUpdateAt < 50) return;
  const elapsed = raceElapsedMs + (raceClockRunning ? now - raceClockSyncAt : 0);
  const text = formatRaceTime(elapsed);
  if (raceClock.textContent !== text) raceClock.textContent = text;
  lastClockUpdateAt = now;
}

function onRaceState(state) {
  const previousPhase = latestState?.phase;
  latestState = state;
  if (state.phase === "countdown" && previousPhase !== "countdown") rewardSignature = "";
  raceElapsedMs = Number(state.raceElapsedMs) || 0;
  raceClockSyncAt = performance.now();
  raceClockRunning = state.phase === "racing";
  if (state.phase !== previousPhase) readControls();
  initializeScene(state.track);
  const seenIds = new Set();
  for (const car of state.cars) {
    seenIds.add(car.id);
    let carView = carViews.get(car.id);
    const signature = cosmeticSignature(car.cosmetics);
    if (!carView || carView.cosmeticSignature !== signature) {
      if (carView) {
        scene.remove(carView.mesh);
        disposeCar(carView.mesh);
      }
      const mesh = createCar(car.color, car.cosmetics);
      scene.add(mesh);
      carView = {
        mesh,
        targetPosition: new THREE.Vector3(car.x, 0, car.z),
        targetYaw: car.yaw,
        speed: car.speed,
        steering: car.steering || 0,
        accelerating: car.accelerating === true,
        braking: car.braking === true,
        cosmeticSignature: signature,
      };
      carViews.set(car.id, carView);
    }
    carView.targetPosition.set(car.x, 0, car.z);
    carView.targetYaw = car.yaw;
    carView.speed = car.speed;
    carView.steering = car.steering || 0;
    carView.accelerating = car.accelerating === true;
    carView.braking = car.braking === true;
    if (car.id === playerId) {
      document.querySelector("#speed-value").textContent = `${car.speed < -0.1 ? "R" : ""}${String(Math.round(Math.abs(car.speed) * 5.3)).padStart(2, "0")}`;
      document.querySelector("#lap-number").textContent = String(car.lap);
      document.querySelector("#place-number").textContent = String(car.place);
      document.querySelector("#place-suffix").textContent = car.place === 1 ? "º" : "º";
    }
  }
  drawMinimap(state);
  for (const [id, carView] of carViews) {
    if (!seenIds.has(id)) {
      scene.remove(carView.mesh);
      disposeCar(carView.mesh);
      carViews.delete(id);
    }
  }

  const signature = state.cars.map((car) => `${car.id}:${car.place}:${car.lap}:${car.finished}`).join("|");
  const now = performance.now();
  if (signature !== lastLeaderboardSignature && (state.phase !== lastRenderedPhase || now - lastLeaderboardUpdate >= 250)) {
    updateLeaderboard(state.cars);
    lastLeaderboardSignature = signature;
    lastLeaderboardUpdate = now;
  }
  lastRenderedPhase = state.phase;
  if (state.phase === "finished" && previousPhase !== "finished") refreshGlobalLeaderboard();
  const isHost = state.hostId === playerId;
  if (state.phase !== "finished") rewardSummary.classList.add("is-hidden");
  startButton.classList.toggle("is-hidden", !(isHost && state.phase === "lobby"));
  restartButton.classList.toggle("is-hidden", !(isHost && state.phase === "finished"));
  document.querySelector("#race-state-label").textContent = ({
    lobby: "SALA",
    countdown: "LISTOS",
    racing: "EN CARRERA",
    finished: "FINAL",
  })[state.phase];
  if (state.phase === "lobby") {
    raceMessage.textContent = isHost ? "¿LISTOS?" : "ESPERANDO";
  } else if (state.phase === "countdown") {
    raceMessage.textContent = state.countdown > 0 ? String(state.countdown) : "¡YA!";
  } else if (state.phase === "racing") {
    raceMessage.textContent = "";
  } else {
    const winner = state.cars[0];
    raceMessage.textContent = winner ? `${winner.name} GANA` : "¡META!";
    const playerCar = state.cars.find((car) => car.id === playerId);
    if (playerCar?.reward) {
      const reward = playerCar.reward;
      const bonuses = [
        reward.completedBonus ? "BONUS 3 VUELTAS" : "",
        reward.fastestLapBonus ? "VUELTA RÁPIDA" : "",
      ].filter(Boolean);
      const pointsBreakdown = `${reward.basePoints} posición + ${reward.completionPoints} vueltas + ${reward.fastestLapPoints} vuelta rápida`;
      const coinsBreakdown = `${reward.baseCoins} posición + ${reward.completionCoins} vueltas + ${reward.fastestLapCoins} vuelta rápida`;
      rewardSummary.textContent = reward.persistenceError
        ? `+${reward.points} PUNTOS (${pointsBreakdown})\n+${reward.coins} RC (${coinsBreakdown})\nRECOMPENSA SIN PERSISTIR`
        : `+${reward.points} PUNTOS (${pointsBreakdown})\n+${reward.coins} RC (${coinsBreakdown})${bonuses.length ? `\n${bonuses.join(" · ")}` : ""}`;
      rewardSummary.classList.remove("is-hidden");
      const signature = `${playerId}:${reward.points}:${reward.coins}`;
      if (signature !== rewardSignature) {
        rewardSignature = signature;
        refreshAccountProfile();
      }
    } else {
      rewardSummary.classList.add("is-hidden");
    }
  }
}

function readControls() {
  const steer = (heldKeys.has("ArrowRight") || heldKeys.has("d") ? 1 : 0)
    - (heldKeys.has("ArrowLeft") || heldKeys.has("a") ? 1 : 0);
  const throttle = heldKeys.has("ArrowUp") || heldKeys.has("w") ? 1 : 0;
  const brake = heldKeys.has("ArrowDown") || heldKeys.has("s") ? 1 : 0;
  if (
    socket?.connected
    && latestState?.phase === "racing"
    && (throttle !== lastSentInput.throttle || brake !== lastSentInput.brake || steer !== lastSentInput.steer)
  ) {
    socket.emit("driverInput", { throttle, brake, steer });
    lastSentInput = { throttle, brake, steer };
  }
}

function updateAccountUi() {
  const accountActions = accountForm.querySelector(".account-actions");
  accountForm.classList.toggle("is-authenticated", Boolean(accountProfile));
  accountSummary.textContent = accountProfile
    ? `${accountProfile.username} · Cuenta`
    : "Cuenta · Iniciar sesión";
  accountBalance.textContent = `${accountProfile?.coins ?? 500} RC`;
  accountBalance.classList.toggle("is-hidden", !accountProfile);
  accountActions.classList.toggle("is-hidden", Boolean(accountProfile));
  logoutButton.classList.toggle("is-hidden", !accountProfile);
  if (accountProfile) accountUsername.value = accountProfile.username;
  updatePilotPanel();
}

async function requestApi(url, { method = "GET", body, authenticated = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authenticated && sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "No se pudo completar la operación.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function refreshCatalogViews() {
  if (!catalogData) return;
  renderCatalogPanel("store");
  renderCatalogPanel("garage");
  const menuCosmetics = getEquippedCosmetics();
  setPreviewAppearance(
    "menu-preview",
    menuCosmetics,
    accountProfile ? `${accountProfile.username} · EQUIPADO` : "CONFIGURACIÓN BASE"
  );
  renderLoadoutSummary(menuCosmetics);
  const storeItem = catalogData.items.find((item) => item.id === selectedStoreItemId);
  const storeCosmetics = storeItem
    ? { ...getEquippedCosmetics(), [storeItem.category]: storeItem.id }
    : getEquippedCosmetics();
  const storeLabel = storeItem ? `${storeItem.name} · vista previa` : "Configuración base gratuita";
  setPreviewAppearance("store-preview", storeCosmetics, storeLabel);

  const garageItem = catalogData.items.find((item) => item.id === selectedGarageItemId);
  const garageCosmetics = garageItem
    ? { ...getEquippedCosmetics(), [garageItem.category]: garageItem.id }
    : getEquippedCosmetics();
  const garageLabel = garageItem ? `${garageItem.name} · vista previa` : "Tu coche equipado";
  setPreviewAppearance("garage-preview", garageCosmetics, garageLabel);
}

function renderCatalogPanel(mode) {
  const isStore = mode === "store";
  const categoryHost = document.getElementById(`${mode}-categories`);
  const itemHost = document.getElementById(`${mode}-items`);
  const message = document.getElementById(`${mode}-message`);
  categoryHost.replaceChildren();
  for (const category of cosmeticCategories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `category-tab${category === selectedCategory ? " is-active" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(category === selectedCategory));
    button.textContent = categoryLabels[category];
    button.addEventListener("click", () => {
      selectedCategory = category;
      selectedStoreItemId = null;
      selectedGarageItemId = null;
      refreshCatalogViews();
    });
    categoryHost.appendChild(button);
  }

  const owned = new Set(accountProfile?.inventory || []);
  const visibleItems = catalogData.items.filter((item) => (
    item.category === selectedCategory && (isStore || owned.has(item.id))
  ));
  itemHost.replaceChildren();
  if (!visibleItems.length) {
    const empty = document.createElement("p");
    empty.className = "catalog-empty";
    empty.textContent = isStore
      ? "No hay artículos en esta categoría."
      : accountProfile ? "Aún no tienes artículos de esta categoría." : "Inicia sesión para consultar tu inventario.";
    itemHost.appendChild(empty);
    if (!isStore) message.textContent = "";
    return;
  }

  const selectedId = isStore ? selectedStoreItemId : selectedGarageItemId;
  const selectedItem = visibleItems.find((item) => item.id === selectedId)
    || visibleItems.find((item) => item.id === accountProfile?.equipped?.[selectedCategory])
    || visibleItems[0];
  if (isStore) selectedStoreItemId = selectedItem.id;
  else selectedGarageItemId = selectedItem.id;

  for (const item of visibleItems) {
    const card = document.createElement("article");
    card.className = `catalog-item${item.id === selectedItem.id ? " is-selected" : ""}`;
    card.addEventListener("click", () => {
      if (isStore) selectedStoreItemId = item.id;
      else selectedGarageItemId = item.id;
      refreshCatalogViews();
    });
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.name;
    const detail = document.createElement("small");
    const equipped = accountProfile?.equipped?.[item.category] === item.id;
    detail.textContent = equipped
      ? "Equipado"
      : owned.has(item.id) ? "Desbloqueado" : item.price === 0 ? "Artículo base" : `${item.price} RaceCoins`;
    description.append(title, detail);
    const action = document.createElement("button");
    action.type = "button";
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      if (isStore && !owned.has(item.id)) buyCatalogItem(item);
      else if (isStore) equipCatalogItem(item, true);
      else equipCatalogItem(item);
    });

    if (isStore) {
      if (equipped) {
        action.textContent = "EQUIPADO";
        action.disabled = true;
      } else if (owned.has(item.id)) {
        action.textContent = "EQUIPAR";
      } else if (!accountProfile) {
        action.textContent = "INICIA SESIÓN";
        action.disabled = true;
      } else {
        action.textContent = `COMPRAR · ${item.price} RC`;
      }
    } else {
      action.textContent = equipped ? "EQUIPADO" : "EQUIPAR";
      action.disabled = equipped;
    }
    card.append(description, action);
    itemHost.appendChild(card);
  }
}

async function buyCatalogItem(item) {
  const message = document.querySelector("#store-message");
  message.textContent = "";
  try {
    accountProfile = await requestApi("/api/shop/buy", { method: "POST", body: { itemId: item.id } });
    updateAccountUi();
    message.textContent = `${item.name} comprado por ${item.price} RC.`;
    refreshCatalogViews();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function equipCatalogItem(item, fromStore = false) {
  const message = document.querySelector(fromStore ? "#store-message" : "#garage-message");
  message.textContent = "";
  try {
    accountProfile = await requestApi("/api/inventory/equip", {
      method: "POST",
      body: { category: item.category, itemId: item.id },
    });
    updateAccountUi();
    message.textContent = `${item.name} equipado.`;
    refreshCatalogViews();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function refreshAccountProfile() {
  if (!sessionToken) {
    accountProfile = null;
    updateAccountUi();
    refreshCatalogViews();
    return null;
  }
  try {
    accountProfile = await requestApi("/api/me");
    accountError.textContent = "";
    updateAccountUi();
    refreshCatalogViews();
    return accountProfile;
  } catch (error) {
    accountError.textContent = error.message;
    if (error.status === 401) {
      sessionToken = "";
      localStorage.removeItem("race2win.sessionToken");
      accountProfile = null;
      updateAccountUi();
      refreshCatalogViews();
    }
    return null;
  }
}

async function authenticate(endpoint) {
  accountError.textContent = "";
  try {
    const result = await requestApi(endpoint, {
      method: "POST",
      body: { username: accountUsername.value.trim(), password: accountPassword.value },
      authenticated: false,
    });
    sessionToken = result.token;
    localStorage.setItem("race2win.sessionToken", sessionToken);
    accountProfile = result.profile;
    accountPassword.value = "";
    accountForm.closest("details").open = false;
    updateAccountUi();
    refreshCatalogViews();
  } catch (error) {
    accountError.textContent = error.message;
  }
}

function showMainScreen(screenId) {
  if (!raceScreen.classList.contains("is-hidden")) return;
  joinScreen.classList.toggle("is-hidden", screenId !== "join-screen");
  storeScreen.classList.toggle("is-hidden", screenId !== "store-screen");
  garageScreen.classList.toggle("is-hidden", screenId !== "garage-screen");
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.screen === screenId);
  });
  if (screenId === "store-screen") initializePreview("store-preview");
  if (screenId === "garage-screen") initializePreview("garage-preview");
  resizePreviewViews();
  refreshCatalogViews();
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showMainScreen(button.dataset.screen));
});
document.querySelector(".garage-quick-link").addEventListener("click", () => showMainScreen("garage-screen"));
document.querySelector("#login-button").addEventListener("click", () => authenticate("/api/login"));
document.querySelector("#register-button").addEventListener("click", () => authenticate("/api/register"));
accountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!accountProfile) authenticate("/api/login");
});
document.querySelector("#driver-name").addEventListener("input", updatePilotPanel);
document.querySelector("#copy-lan").addEventListener("click", copyLanAddress);
document.querySelectorAll(".track-card").forEach((card) => {
  card.addEventListener("click", () => selectTrack(card.dataset.trackId));
});
document.querySelectorAll(".participant-pill").forEach((button) => {
  button.addEventListener("click", () => {
    const count = Number(button.dataset.playerCount);
    document.querySelector("#max-players").value = String(count);
    document.querySelector("#participant-count").textContent = String(count);
    document.querySelectorAll(".participant-pill").forEach((pill) => {
      const selected = pill === button;
      pill.classList.toggle("is-selected", selected);
      pill.setAttribute("aria-pressed", String(selected));
    });
  });
});
logoutButton.addEventListener("click", async () => {
  try {
    await requestApi("/api/logout", { method: "POST", body: {} });
  } catch (error) {
    accountError.textContent = error.message;
  }
  sessionToken = "";
  accountProfile = null;
  localStorage.removeItem("race2win.sessionToken");
  updateAccountUi();
  refreshCatalogViews();
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinError.textContent = "";
  const formData = new FormData(joinForm);
  rewardSummary.classList.add("is-hidden");
  socket = window.io({ auth: sessionToken ? { token: sessionToken } : {} });
  connectionLabel.textContent = "CONECTANDO";
  socket.on("connect", () => {
    connectionLabel.textContent = "CONECTADO";
    socket.emit("joinRace", {
      name: formData.get("name"),
      maxPlayers: Number(formData.get("maxPlayers")),
      botsEnabled: formData.get("botsEnabled") === "on",
      trackId: formData.get("trackId"),
      token: sessionToken || undefined,
    }, (result) => {
      if (!result?.ok) {
        joinError.textContent = result?.error || "No se pudo entrar en la sala.";
        socket.disconnect();
        return;
      }
      playerId = result.id;
      joinScreen.classList.add("is-hidden");
      storeScreen.classList.add("is-hidden");
      garageScreen.classList.add("is-hidden");
      raceScreen.classList.remove("is-hidden");
      resizeRenderer();
    });
  });
  socket.on("connect_error", (error) => {
    connectionLabel.textContent = "SIN CONEXIÓN";
    joinError.textContent = error.message?.includes("sesión")
      ? "La sesión de la cuenta ha caducado. Inicia sesión de nuevo."
      : "No se pudo conectar con el servidor local.";
  });
  socket.on("raceState", onRaceState);
});

startButton.addEventListener("click", () => socket?.emit("startRace"));
restartButton.addEventListener("click", () => socket?.emit("restartRace"));
leaveButton.addEventListener("click", () => {
  socket?.disconnect();
  socket = null;
  playerId = null;
  latestState = null;
  heldKeys.clear();
  lastSentInput = { throttle: 0, brake: 0, steer: 0 };
  joinScreen.classList.remove("is-hidden");
  raceScreen.classList.add("is-hidden");
  storeScreen.classList.add("is-hidden");
  garageScreen.classList.add("is-hidden");
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.screen === "join-screen");
  });
  rewardSummary.classList.add("is-hidden");
  joinError.textContent = "";
  connectionLabel.textContent = "SERVIDOR LOCAL";
});

window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  heldKeys.add(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  readControls();
});
window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  readControls();
});
window.addEventListener("blur", () => {
  heldKeys.clear();
  readControls();
});
window.addEventListener("resize", resizeRenderer);

async function initializeCatalog() {
  try {
    const [catalogResponse, tracksResponse] = await Promise.all([
      fetch("/catalog.json"),
      fetch("/tracks.json"),
    ]);
    if (!catalogResponse.ok) throw new Error("No se pudo cargar el catálogo de cosméticos.");
    if (!tracksResponse.ok) throw new Error("No se pudieron cargar los circuitos.");
    catalogData = await catalogResponse.json();
    drawTrackCards(await tracksResponse.json());
    initializePreview("menu-preview");
    refreshCatalogViews();
    await refreshAccountProfile();
    await Promise.all([refreshGlobalLeaderboard(), initializeLanInvite()]);
  } catch (error) {
    accountError.textContent = error.message;
    console.error("No se pudo inicializar la tienda y el garaje.", error);
  }
}

updateAccountUi();
initializeCatalog();
