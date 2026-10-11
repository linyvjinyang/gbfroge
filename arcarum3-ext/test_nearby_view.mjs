import assert from "node:assert/strict";
import {
  NEARBY_HOPS,
  NEARBY_MAX_SCALE,
  NEARBY_MIN_SCALE,
  fitBounds,
  nearbyBounds,
} from "./shared/path/nearbyView.js";

/** 一条横向的链：节点 1..10，间距 100，y 固定 500 */
function chain(current) {
  return {
    current_node_id: current,
    node_list: Array.from({ length: 10 }, (_, index) => {
      const id = index + 1;
      return {
        node_id: id,
        node_type: 0,
        position_x: id * 100,
        position_y: 500,
        adjacent_node_ids: [id - 1, id + 1].filter((n) => n >= 1 && n <= 10),
      };
    }),
  };
}

// —— 周围几步的包围盒 ——
{
  assert.equal(NEARBY_HOPS, 3);
  const middle = nearbyBounds(chain(5));
  assert.deepEqual(middle.nodeIds, [2, 3, 4, 5, 6, 7, 8], "当前位置前后各 3 步");
  assert.deepEqual([middle.minX, middle.maxX, middle.minY, middle.maxY], [200, 800, 500, 500]);
  assert.deepEqual(middle.focus, { x: 500, y: 500 }, "focus 是当前位置");

  const edge = nearbyBounds(chain(1));
  assert.deepEqual(edge.nodeIds, [1, 2, 3, 4], "在地图边上时只有一侧");

  assert.deepEqual(nearbyBounds(chain(5), 1).nodeIds, [4, 5, 6]);
  assert.equal(nearbyBounds(chain(null)), null, "没有当前位置");
  assert.equal(nearbyBounds(null), null);
  assert.equal(nearbyBounds({ current_node_id: 99, node_list: chain(1).node_list }), null);

  // Boss 挡路时不把它后面的节点算进来
  const blocked = chain(5);
  blocked.node_list.find((n) => n.node_id === 6).node_type = 1;
  assert.deepEqual(nearbyBounds(blocked).nodeIds, [2, 3, 4, 5, 6]);
}

// —— 铺进视口 ——
{
  const bounds = { minX: 200, maxX: 800, minY: 400, maxY: 700 };
  const view = fitBounds(bounds, 1000, 600, { padding: 100 });
  // 可用区域 800×400，内容 600×300 → 两个方向都是 1.333，被上限压到 1.1
  assert.equal(view.scale, NEARBY_MAX_SCALE);
  // 包围盒中心 (500, 550) 落在视口中心 (500, 300)
  assert.ok(Math.abs(500 * view.scale + view.ox - 500) < 1e-9);
  assert.ok(Math.abs(550 * view.scale + view.oy - 300) < 1e-9);

  // 内容很大：缩到能放下，但不低于下限
  const wide = fitBounds({ minX: 0, maxX: 1000, minY: 0, maxY: 100 }, 700, 600, { padding: 100 });
  assert.equal(wide.scale, 0.5, "按宽度算 500 / 1000");
  const huge = fitBounds({ minX: 0, maxX: 10000, minY: 0, maxY: 10000 }, 700, 600);
  assert.equal(huge.scale, NEARBY_MIN_SCALE);

  // 缩到下限也放不下：以当前位置为中心，而不是包围盒中心
  const focused = fitBounds(
    { minX: 0, maxX: 10000, minY: 0, maxY: 10000, focus: { x: 9000, y: 800 } },
    700,
    600,
  );
  assert.equal(focused.scale, NEARBY_MIN_SCALE);
  assert.ok(Math.abs(9000 * focused.scale + focused.ox - 350) < 1e-9, "当前位置在画面正中");
  assert.ok(Math.abs(800 * focused.scale + focused.oy - 300) < 1e-9);
  // 放得下时仍然按包围盒居中，让周围节点都看得到
  const fits = fitBounds({ ...bounds, focus: { x: 200, y: 400 } }, 1000, 600, { padding: 100 });
  assert.ok(Math.abs(500 * fits.scale + fits.ox - 500) < 1e-9);

  // 只有一个节点（包围盒没有面积）：用最大倍率并居中
  const single = fitBounds({ minX: 300, maxX: 300, minY: 300, maxY: 300 }, 800, 600);
  assert.equal(single.scale, NEARBY_MAX_SCALE);
  assert.ok(Math.abs(300 * single.scale + single.ox - 400) < 1e-9);

  // 视口比留白还小也不会算出负数或 NaN
  const tiny = fitBounds(bounds, 50, 50, { padding: 100 });
  assert.ok(Number.isFinite(tiny.scale) && tiny.scale >= NEARBY_MIN_SCALE);
}

// —— 附近视图一定比全图更近 ——
{
  const mapWidth = 2680;
  const mapHeight = 1830;
  const viewWidth = 900;
  const viewHeight = 760;
  const fullScale = Math.min((viewWidth - 40) / mapWidth, (viewHeight - 40) / mapHeight);
  const near = fitBounds(nearbyBounds(chain(5)), viewWidth, viewHeight);
  assert.ok(near.scale > fullScale * 1.3, `附近 ${near.scale} 应明显大于全图 ${fullScale}`);
}

console.log("nearby view tests passed");
