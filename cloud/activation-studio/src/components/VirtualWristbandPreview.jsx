import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Center, Environment, OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import * as THREE from "three";
import "./VirtualWristbandPreview.css";

const FBX_URL = "/assets/wristband.fbx";

const FBX_BINARY_MAGIC = "Kaydara FBX Binary  ";

function looksLikeHtml(bytes) {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 64)).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<?xml");
}

function looksLikeGitLfsPointer(bytes) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 200));
  return text.includes("git-lfs.github.com/spec/v1") || text.startsWith("version https://git-lfs.github.com/spec/v1");
}

function validateFbxBytes(buffer) {
  if (!buffer || buffer.byteLength < 32) {
    return "Downloaded file is empty or too small to be an FBX.";
  }
  const bytes = new Uint8Array(buffer);

  if (looksLikeHtml(bytes)) {
    return "The URL returned HTML (often a 404 page) instead of an FBX file. Put a real wristband.fbx in public/assets/.";
  }
  if (looksLikeGitLfsPointer(bytes)) {
    return "This looks like a Git LFS pointer file, not the actual FBX binary. Fetch the real model bytes (or copy the resolved file) into public/assets/wristband.fbx.";
  }

  const asciiProbe = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, Math.min(bytes.length, 4096)));
  if (asciiProbe.includes("; fbx") || asciiProbe.toLowerCase().includes("fbxheaderextension")) {
    return null;
  }

  const magic = new TextDecoder("ascii", { fatal: false }).decode(bytes.slice(0, FBX_BINARY_MAGIC.length));
  if (magic !== FBX_BINARY_MAGIC) {
    return "File does not look like FBX ASCII or FBX binary (missing Kaydara FBX header). Replace public/assets/wristband.fbx with a valid export.";
  }

  return null;
}

/** Initial pose: ~3/4 view, slightly from above (like product reference), radians. */
const WRISTBAND_REST_ROTATION = [
  THREE.MathUtils.degToRad(20),
  THREE.MathUtils.degToRad(50 + 90),
  THREE.MathUtils.degToRad(20),
];

const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

/** Match Fusion / FBX node names on self or any ancestor (e.g. group "Emitter" → child Mesh). */
function classifyWristbandPart(obj) {
  const parts = [];
  let o = obj;
  while (o) {
    if (o.name) parts.push(String(o.name).toLowerCase());
    o = o.parent;
  }
  const blob = parts.join(" ");
  if (blob.includes("emitter")) return "emitter";
  if (blob.includes("casing")) return "casing";
  if (blob.includes("wristband")) return "silicone";
  return "silicone";
}

function setMeshMaterial(mesh, material) {
  const prev = mesh.material;
  if (Array.isArray(prev)) {
    prev.forEach((m) => m?.dispose?.());
  } else {
    prev?.dispose?.();
  }
  mesh.material = material;
}

/**
 * Ortho camera fits the loaded FBX along its thinnest axis (flat presentation).
 */
function FitTopDownCamera({ children }) {
  const groupRef = useRef(null);
  const { camera, size } = useThree();

  useLayoutEffect(() => {
    const root = groupRef.current;
    if (!root) return;
    const cam = camera;
    if (!(cam instanceof THREE.OrthographicCamera)) return;

    const v = new THREE.Vector3();

    /* eslint-disable react-hooks/immutability -- Three.js ortho camera is updated to frame the mesh */
    const fit = () => {
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return;

      const center = new THREE.Vector3();
      box.getCenter(center);
      const sz = new THREE.Vector3();
      box.getSize(sz);

      const ax =
        sz.x <= sz.y && sz.x <= sz.z
          ? new THREE.Vector3(1, 0, 0)
          : sz.y <= sz.x && sz.y <= sz.z
            ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(0, 0, 1);

      const maxSpan = Math.max(sz.x, sz.y, sz.z);
      const lift = maxSpan * 1.35 + Math.min(sz.x, sz.y, sz.z) * 0.5;

      cam.position.copy(center).add(ax.clone().multiplyScalar(lift));
      cam.up.set(0, 1, 0);
      if (Math.abs(ax.y) > 0.9) cam.up.set(0, 0, -1);
      cam.lookAt(center);
      cam.updateMatrixWorld(true);

      const inv = cam.matrixWorldInverse;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      for (let i = 0; i < 8; i++) {
        const m = CORNERS[i];
        v.set(m[0] ? box.max.x : box.min.x, m[1] ? box.max.y : box.min.y, m[2] ? box.max.z : box.min.z);
        v.applyMatrix4(inv);
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }

      const margin = 1.14;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      let halfW = ((maxX - minX) * margin) / 2;
      let halfH = ((maxY - minY) * margin) / 2;
      const aspect = size.width / Math.max(1, size.height);
      if (halfW / halfH > aspect) halfH = halfW / aspect;
      else halfW = halfH * aspect;

      cam.left = cx - halfW;
      cam.right = cx + halfW;
      cam.top = cy + halfH;
      cam.bottom = cy - halfH;
      cam.near = 0.05;
      cam.far = Math.max(200, maxSpan * 15);
      cam.updateProjectionMatrix();
    };
    /* eslint-enable react-hooks/immutability */

    fit();
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [camera, size.width, size.height]);

  return <group ref={groupRef}>{children}</group>;
}

function WristbandFbx({ fbx, sampleAura }) {
  const emitterMaterialsRef = useRef([]);
  const emitterMeshesRef = useRef([]);
  const siliconeMaterialsRef = useRef([]);
  const casingMaterialsRef = useRef([]);
  const auraLightRef = useRef(null);
  const rootGroupRef = useRef(null);

  const fbxModel = useMemo(() => {
    const root = fbx.clone(true);
    const emitterMaterials = [];
    const emitterMeshes = [];
    const siliconeMaterials = [];
    const casingMaterials = [];

    root.traverse((child) => {
      if (!child.isMesh) return;

      const kind = classifyWristbandPart(child);

      if (kind === "emitter") {
        const m = new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xffffff),
          toneMapped: false,
        });
        m.polygonOffset = true;
        m.polygonOffsetFactor = -1;
        m.polygonOffsetUnits = -1;
        setMeshMaterial(child, m);
        child.renderOrder = 2;
        emitterMaterials.push(m);
        emitterMeshes.push(child);
        return;
      }

      if (kind === "casing") {
        const m = new THREE.MeshStandardMaterial({
          color: new THREE.Color(0xdfe2e8),
          roughness: 0.48,
          metalness: 0.03,
          emissive: new THREE.Color(0x000000),
        });
        setMeshMaterial(child, m);
        casingMaterials.push(m);
        return;
      }

      const m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0xf2f4f8),
        roughness: 0.46,
        metalness: 0,
        emissive: new THREE.Color(0x000000),
        envMapIntensity: 0.35,
      });
      child.renderOrder = 0;
      setMeshMaterial(child, m);
      siliconeMaterials.push(m);
    });

    return { scene: root, emitterMaterials, emitterMeshes, siliconeMaterials, casingMaterials };
  }, [fbx]);

  useLayoutEffect(() => {
    emitterMaterialsRef.current = fbxModel.emitterMaterials;
    emitterMeshesRef.current = fbxModel.emitterMeshes;
    siliconeMaterialsRef.current = fbxModel.siliconeMaterials;
    casingMaterialsRef.current = fbxModel.casingMaterials;
  }, [fbxModel]);

  const boxScratch = useMemo(() => new THREE.Box3(), []);
  const centerScratch = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const raw = sampleAura(performance.now());
    const r = Number(raw?.r) || 0;
    const g = Number(raw?.g) || 0;
    const b = Number(raw?.b) || 0;
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const l = (r + g + b) / (3 * 255);
    const gain = 3.2 + l * 9.5;
    for (const mat of emitterMaterialsRef.current) {
      mat.color.setRGB(rn * gain, gn * gain, bn * gain);
    }

    const silIntensity = 0.48 + l * 1.75;
    for (const mat of siliconeMaterialsRef.current) {
      mat.emissive.setRGB(rn, gn, bn);
      // eslint-disable-next-line react-hooks/immutability -- THREE.Material runtime update
      mat.emissiveIntensity = silIntensity;
    }
    const caseIntensity = 0.18 + l * 0.72;
    for (const mat of casingMaterialsRef.current) {
      mat.emissive.setRGB(rn, gn, bn);
      // eslint-disable-next-line react-hooks/immutability -- THREE.Material runtime update
      mat.emissiveIntensity = caseIntensity;
    }

    const light = auraLightRef.current;
    const rootGrp = rootGroupRef.current;
    if (light && rootGrp) {
      rootGrp.updateMatrixWorld(true);
      const meshes = emitterMeshesRef.current;
      if (meshes.length) {
        boxScratch.makeEmpty();
        for (const mesh of meshes) {
          boxScratch.expandByObject(mesh);
        }
        if (!boxScratch.isEmpty()) {
          boxScratch.getCenter(centerScratch);
          rootGrp.worldToLocal(centerScratch);
          light.position.copy(centerScratch);
        }
      }
      light.color.setRGB(rn, gn, bn);
      light.intensity = 115 + l * 340;
    }
  });

  return (
    <group ref={rootGroupRef}>
      <pointLight ref={auraLightRef} distance={0} decay={2} intensity={130} />
      <primitive object={fbxModel.scene} />
    </group>
  );
}

function SceneContent({ sampleAura, disableCanvasZoom }) {
  const fbx = useLoader(FBXLoader, FBX_URL);
  return (
    <>
      <ambientLight intensity={0.2} />
      <hemisphereLight args={["#d8dce3", "#14161c", 0.28]} />
      <directionalLight position={[0.6, 1.2, 0.45]} intensity={0.2} color="#dfe3ea" />
      <directionalLight position={[-0.85, 0.35, -0.5]} intensity={0.08} color="#8b9099" />
      <Environment preset="city" environmentIntensity={0.18} />
      <FitTopDownCamera>
        <Center precise>
          <group rotation={WRISTBAND_REST_ROTATION}>
            <WristbandFbx fbx={fbx} sampleAura={sampleAura} />
          </group>
        </Center>
      </FitTopDownCamera>
      <OrbitControls
        makeDefault
        enabled={!disableCanvasZoom}
        enableZoom={!disableCanvasZoom}
        enableRotate={!disableCanvasZoom}
        enablePan={!disableCanvasZoom}
        enableDamping
        dampingFactor={0.08}
        target={[0, 0, 0]}
        minPolarAngle={0.12}
        maxPolarAngle={Math.PI - 0.12}
        screenSpacePanning
      />
      <EffectComposer multisampling={4} enableNormalPass={false}>
        <Bloom luminanceThreshold={0.26} luminanceSmoothing={0.4} intensity={1.38} mipmapBlur radius={0.52} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </>
  );
}

/**
 * Loads `public/assets/wristband.fbx` (same path as Cloud Controller Show Control).
 * `sampleAura(nowMs)` should return `{ r, g, b }` in 0–255.
 */
export default function VirtualWristbandPreview({ sampleAura, className = "", disableCanvasZoom = false }) {
  const [preflightError, setPreflightError] = useState(null);
  const [preflightOk, setPreflightOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreflightOk(false);
    setPreflightError(null);

    (async () => {
      try {
        const res = await fetch(FBX_URL);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} while fetching ${FBX_URL}`);
        }
        const buf = await res.arrayBuffer();
        const msg = validateFbxBytes(buf);
        if (cancelled) return;
        if (msg) setPreflightError(msg);
        else setPreflightOk(true);
      } catch (e) {
        if (cancelled) return;
        setPreflightError(e?.message || "Failed to fetch wristband model.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const wrapClass = [
    "virtual-wristband-preview",
    disableCanvasZoom ? "virtual-wristband-preview--page-zoom" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapClass}>
      {preflightError ? (
        <div className="virtual-wristband-preview-error" role="status">
          <div className="virtual-wristband-preview-error-title">Wristband 3D model unavailable</div>
          <div className="virtual-wristband-preview-error-body">{preflightError}</div>
          <div className="virtual-wristband-preview-error-hint">
            Expected file: <code>marketing-activation-studio/public/assets/wristband.fbx</code>
          </div>
        </div>
      ) : !preflightOk ? (
        <div className="virtual-wristband-preview-loading" aria-hidden="true" />
      ) : (
        <Canvas
          orthographic
          gl={{ alpha: false, antialias: true, powerPreference: "high-performance" }}
          dpr={[1, 2]}
          camera={{ position: [0, 8, 0], near: 0.05, far: 200, zoom: 1 }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.NoToneMapping;
          }}
        >
          <color attach="background" args={["#1a1b1f"]} />
          <Suspense fallback={null}>
            <SceneContent sampleAura={sampleAura} disableCanvasZoom={disableCanvasZoom} />
          </Suspense>
        </Canvas>
      )}
      <p className="virtual-wristband-preview-caption">
        {preflightError ? (
          <>Fix the asset above to re-enable the 3D wristband preview.</>
        ) : disableCanvasZoom ? (
          <>Static preview — use Wristband Sync for live hardware</>
        ) : (
          <>Drag to orbit · scroll to zoom · right-drag to pan</>
        )}
      </p>
    </div>
  );
}
