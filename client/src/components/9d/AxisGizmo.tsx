import * as THREE from "three";

export function createAxisGizmo() {
  const gizmoScene = new THREE.Scene();
  const GIZMO_FRUSTUM = 1.6;
  const gizmoCamera = new THREE.OrthographicCamera(
    -GIZMO_FRUSTUM,
    GIZMO_FRUSTUM,
    GIZMO_FRUSTUM,
    -GIZMO_FRUSTUM,
    0.1,
    10,
  );
  gizmoCamera.position.set(0, 0, 3);
  gizmoCamera.lookAt(0, 0, 0);

  const gizmoRoot = new THREE.Group();
  gizmoScene.add(gizmoRoot);

  const AXIS_LEN = 1.0;
  const AXIS_RADIUS = 0.055;
  const TIP_LEN = 0.22;
  const TIP_RADIUS = 0.11;

  const makeAxisLabelSprite = (text: string, color: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.beginPath();
      ctx.arc(128, 128, 88, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.20)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = "bold 140px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 128, 132);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.08, 1.08, 1.08);
    return sprite;
  };

  const makeAxis = (kind: "x" | "y" | "z", color: number) => {
    const mat = new THREE.MeshBasicMaterial({
      color,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });

    const axis = new THREE.Group();
    const bodyGeom = new THREE.CylinderGeometry(AXIS_RADIUS, AXIS_RADIUS, AXIS_LEN, 16);
    const tipGeom = new THREE.ConeGeometry(TIP_RADIUS, TIP_LEN, 16);
    const body = new THREE.Mesh(bodyGeom, mat);
    const tip = new THREE.Mesh(tipGeom, mat);

    body.position.set(0, AXIS_LEN / 2, 0);
    tip.position.set(0, AXIS_LEN + TIP_LEN / 2, 0);
    axis.add(body, tip);

    // 三轴恢复 three.js 默认含义：
    // X：右 (+X)，Y：上 (+Y)，Z：出屏 (+Z)
    if (kind === "x") {
      axis.rotation.z = -Math.PI / 2; // Y 轴指向 X 方向
    } else if (kind === "z") {
      axis.rotation.x = Math.PI / 2; // Y 轴指向 Z 方向
    } // kind === 'y' 时保持默认 +Y
    return axis;
  };

  gizmoRoot.add(
    makeAxis("x", 0xef4444),
    makeAxis("y", 0x22c55e),
    makeAxis("z", 0x3b82f6),
  );

  const xLabel = makeAxisLabelSprite("X", "#ef4444");
  const yLabel = makeAxisLabelSprite("Y", "#22c55e");
  const zLabel = makeAxisLabelSprite("Z", "#3b82f6");
  // X 右、Y 上、Z 出屏
  xLabel.position.set(1.25, 0, 0);
  yLabel.position.set(0, 1.25, 0);
  zLabel.position.set(0, 0, 1.25);
  gizmoRoot.add(xLabel, yLabel, zLabel);

  return { gizmoScene, gizmoCamera, gizmoRoot };
}

