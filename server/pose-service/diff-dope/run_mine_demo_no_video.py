import json
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import torch
from omegaconf import OmegaConf

import diffdope as dd


def load_intrinsics(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        intr = json.load(f)
    return intr


def load_labelme_masks(path: Path, h: int, w: int):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    masks = []
    for s in data.get("shapes", []):
        shape_type = s.get("shape_type", "")
        dax_type = s.get("flags", {}).get("dax_type", "")
        if shape_type != "polygon":
            continue
        if dax_type and dax_type != "mask":
            continue
        pts = np.array(s.get("points", []), dtype=np.float32)
        if pts.shape[0] < 3:
            continue
        m = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(m, [pts.astype(np.int32)], 255)
        masks.append({"label": s.get("label", "obj"), "mask": m})
    return masks


def load_depth_raw_cm(root: Path, intr: dict):
    depth_npy_path = root / "depth_raw_head_1.npy"
    depth_png_path = root / "depth_head_1.png"

    depth_raw = None
    depth_source = None
    source_is_npy = False

    if depth_npy_path.exists():
        depth_raw = np.load(str(depth_npy_path))
        depth_source = str(depth_npy_path)
        source_is_npy = True
    else:
        depth_raw = cv2.imread(str(depth_png_path), cv2.IMREAD_UNCHANGED)
        depth_source = str(depth_png_path)

    if depth_raw is None:
        raise FileNotFoundError(
            f"Cannot load depth from {depth_npy_path} or {depth_png_path}"
        )

    if depth_raw.ndim == 3:
        if depth_raw.shape[2] == 1:
            depth_raw = depth_raw[:, :, 0]
        else:
            if np.array_equal(depth_raw[:, :, 0], depth_raw[:, :, 1]) and np.array_equal(
                depth_raw[:, :, 1], depth_raw[:, :, 2]
            ):
                depth_raw = depth_raw[:, :, 0]
            else:
                ranges = [
                    float(depth_raw[:, :, c].max() - depth_raw[:, :, c].min())
                    for c in range(depth_raw.shape[2])
                ]
                depth_raw = depth_raw[:, :, int(np.argmax(ranges))]

    if depth_raw.ndim != 2:
        raise RuntimeError(f"Depth data must be 2D after conversion, got shape={depth_raw.shape}")

    depth_raw = depth_raw.astype(np.float32)
    if source_is_npy and np.issubdtype(depth_raw.dtype, np.floating):
        positive = depth_raw[depth_raw > 0]
        p50 = float(np.median(positive)) if positive.size > 0 else 0.0
        p99 = float(np.percentile(positive, 99)) if positive.size > 0 else 0.0
        if p99 <= 20.0 and p50 > 0.0:
            depth_cm = depth_raw * 100.0
        else:
            depth_cm = depth_raw * float(intr.get("depth_scale", 0.001)) * 100.0
    else:
        depth_cm = depth_raw * float(intr.get("depth_scale", 0.001)) * 100.0
    return depth_cm, depth_source


def main():
    root = Path(__file__).resolve().parent
    rgb_path = root / "rgb_head_1.png"
    intr_path = root / "intrinsics_head.json"
    overlay_path = root / "rgb_head_1.json"
    model_path = root / "yigencong.obj"

    out_dir = root / f"outputs_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    vis_dir = out_dir / "visualizations"
    vis_dir.mkdir(parents=True, exist_ok=True)

    intr = load_intrinsics(intr_path)
    rgb = cv2.imread(str(rgb_path))
    if rgb is None:
        raise FileNotFoundError(f"Cannot read rgb: {rgb_path}")
    h, w = rgb.shape[:2]

    masks = load_labelme_masks(overlay_path, h, w)
    if len(masks) == 0:
        raise RuntimeError("No polygon masks found in overlay json.")

    depth_cm, depth_source = load_depth_raw_cm(root, intr)

    cfg = OmegaConf.load(str(root.parent / "configs" / "diffdope.yaml"))
    cfg.camera.fx = float(intr["fx"])
    cfg.camera.fy = float(intr["fy"])
    cfg.camera.cx = float(intr.get("cx", intr.get("ppx")))
    cfg.camera.cy = float(intr.get("cy", intr.get("ppy")))
    cfg.camera.im_width = int(intr["width"])
    cfg.camera.im_height = int(intr["height"])
    cfg.scene.path_img = str(rgb_path)
    cfg.scene.path_depth = None
    cfg.scene.path_segmentation = None
    cfg.scene.image_resize = 1.0
    # Render full-frame overlay instead of mask-cropped view.
    cfg.render_images.crop_around_mask = False
    cfg.object3d.model_path = str(model_path)
    cfg.object3d.scale = 100.0
    cfg.object3d.position = [0.0, 0.0, 80.0]
    cfg.object3d.rotation = [0.0, 0.0, 0.0, 1.0]
    cfg.hyperparameters.nb_iterations = 80
    cfg.hyperparameters.batchsize = 8
    cfg.losses.l1_mask = True
    cfg.losses.weight_mask = 1.0
    cfg.losses.l1_depth_with_mask = False
    cfg.losses.l1_rgb_with_mask = False

    ddope = dd.DiffDope(cfg=cfg)
    scene = dd.Scene(path_img=str(rgb_path), path_depth=None, path_segmentation=None, image_resize=1.0)
    scene.cuda()

    mesh = dd.Mesh(str(model_path), scale=100.0)
    mesh.cuda()

    results = []
    for i, item in enumerate(masks):
        mask = item["mask"]
        ys, xs = np.where(mask > 0)
        if len(xs) == 0:
            continue

        u = float(np.median(xs))
        v = float(np.median(ys))
        valid_depth = depth_cm[mask > 0]
        valid_depth = valid_depth[valid_depth > 0]
        z = float(np.median(valid_depth)) if len(valid_depth) > 0 else 80.0
        x = (u - cfg.camera.cx) * z / cfg.camera.fx
        y = (v - cfg.camera.cy) * z / cfg.camera.fy

        obj = dd.Object3D(
            position=[x, y, z],
            rotation=[0.0, 0.0, 0.0, 1.0],
            batchsize=cfg.hyperparameters.batchsize,
            opencv2opengl=True,
            scale=1.0,
        )
        obj.mesh = mesh
        obj.mesh.set_batchsize(cfg.hyperparameters.batchsize)
        obj.cuda()

        m = cv2.flip(mask, 0).astype(np.float32) / 255.0
        m3 = np.stack([m, m, m], axis=-1)
        m_batch = torch.tensor(np.stack([m3] * cfg.hyperparameters.batchsize, axis=0), dtype=torch.float32).cuda()
        seg = dd.Image(img_tensor=m_batch, flip_img=False)
        seg._batchsize_set = True
        scene.tensor_segmentation = seg

        d = cv2.flip(depth_cm, 0).astype(np.float32)
        d_batch = torch.tensor(np.stack([d] * cfg.hyperparameters.batchsize, axis=0), dtype=torch.float32).cuda()
        depth_img = dd.Image(img_tensor=d_batch, flip_img=False, depth=True)
        depth_img._batchsize_set = True
        scene.tensor_depth = depth_img

        ddope.scene = scene
        ddope.object3d = obj
        ddope.set_batchsize(cfg.hyperparameters.batchsize)

        ddope.cfg.losses.l1_mask = True
        ddope.cfg.losses.weight_mask = 1.0
        ddope.cfg.losses.l1_depth_with_mask = False
        ddope.cfg.losses.l1_rgb_with_mask = False
        ddope.loss_functions = [dd.l1_mask]
        ddope.run_optimization()

        ddope.cfg.losses.l1_mask = True
        ddope.cfg.losses.weight_mask = 0.5
        ddope.cfg.losses.l1_depth_with_mask = True
        ddope.cfg.losses.weight_depth = 1.0
        ddope.cfg.losses.l1_rgb_with_mask = False
        ddope.loss_functions = [dd.l1_mask, dd.l1_depth_with_mask]
        ddope.cfg.hyperparameters.nb_iterations = 120
        ddope.run_optimization()

        argmin = int(ddope.get_argmin())
        pose = ddope.get_pose(batch_index=argmin).tolist()
        vis = ddope.render_img(batch_index=argmin, render_selection="rgb")
        vis_path = vis_dir / f"instance_{i:03d}_{item['label']}.png"
        cv2.imwrite(str(vis_path), vis)

        results.append(
            {
                "instance_index": i,
                "label": item["label"],
                "argmin": argmin,
                "pose_4x4": pose,
                "visualization": str(vis_path),
                "init_xyz_cm": [x, y, z],
            }
        )

    out_json = out_dir / "poses.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"results": results}, f, indent=2, ensure_ascii=False)

    print("\n=== Diff-DOPE demo finished (no video) ===")
    print(f"Instances processed: {len(results)}")
    print(f"Depth source used: {depth_source}")
    print(f"Output folder: {out_dir}")
    print(f"Poses json: {out_json}")
    print(f"Visualizations: {vis_dir}")


if __name__ == "__main__":
    main()

