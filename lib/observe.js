/**
 * observe.js —— 观察状态、有效期与坐标原点。
 *
 * 设计原则：**先观察，再操作**。
 *
 *   1. 任何会改变桌面状态的动作，执行前必须有一次"新鲜的"观察（一次截图）；
 *      没有观察就直接点击/打字/按键，一律拒绝。
 *   2. 观察结果有 TTL，超过 TTL 即失效（界面可能已经变了）。
 *   3. 任何改变桌面状态的动作执行完，观察立即作废——因为界面可能已经因此改变，
 *      下一次写操作必须重新观察。这样"看的是 A 屏、点的是 B 屏"不可能发生。
 *   4. 观察同时记下截图区域在屏幕上的原点，用来把"图上的像素"换算成
 *      "屏幕绝对坐标"，避免模型拿窗口截图的局部像素去点屏幕坐标。
 *
 * 本模块只保存状态，不做任何 I/O，也不依赖宿主服务，便于单测。
 */

/** @type {{at:number,target:string,label:string,origin:{x:number,y:number},width:number,height:number,scale:number,stale:boolean,fingerprint:Buffer|null,fingerprintRegion:object|null}|null} */
let observation = null

/**
 * 记录一次观察结果。
 * @param {object} options 观察信息。
 * @param {Buffer|null} options.fingerprint 屏幕灰度指纹，用于比较画面是否变化（作废观察时保留）。
 * @param {object|null} options.fingerprintRegion 指纹对应的屏幕区域。
 */
export function recordObservation({
  target,
  label,
  origin,
  width,
  height,
  scale,
  fingerprint = null,
  fingerprintRegion = null,
} = {}) {
  observation = {
    at: Date.now(),
    target: typeof target === 'string' ? target : 'screen',
    label: typeof label === 'string' ? label : '',
    origin: {
      x: Math.round(Number(origin?.x ?? 0)),
      y: Math.round(Number(origin?.y ?? 0)),
    },
    width: Math.round(Number(width ?? 0)),
    height: Math.round(Number(height ?? 0)),
    // 图上像素 → 屏幕像素的倍率（截图被缩小时 > 1）。
    scale: Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1,
    stale: false,
    // 画面指纹：作废观察时保留，便于判断「动作之后画面是否变化」。
    fingerprint: fingerprint ?? null,
    fingerprintRegion: fingerprintRegion ?? null,
  }
  return observation
}

/** 读取当前观察结果（可能为 null）。 */
export function getObservation() {
  return observation
}

/** 让当前观察作废（状态改变后调用）。 */
export function invalidateObservation() {
  if (observation) observation.stale = true
}

/**
 * 只更新观察记录里的画面指纹，不改变观察的时间与新鲜度。
 *
 * 用途：`linux_verify_state` 在比对完画面之后把新的指纹写回观察记录，
 * 这样下一次校验可以对比「上一次校验时」的画面。写门禁不会被它放开——
 * `at` 与 `stale` 原样保留，仍然必须重新截图才能执行写操作。
 *
 * @param {Buffer|null} fingerprint 新的灰度指纹。
 * @param {object|null} fingerprintRegion 指纹对应的屏幕区域。
 * @returns {boolean} 是否写入了（没有观察记录时返回 false）。
 */
export function updateFingerprint(fingerprint, fingerprintRegion = null) {
  if (!observation) return false
  observation.fingerprint = fingerprint ?? null
  observation.fingerprintRegion = fingerprintRegion ?? null
  return true
}

/** 清空观察状态。 */
export function clearObservation() {
  observation = null
}

/** 观察距今多少毫秒；没有观察时返回 null。 */
export function observationAgeMs() {
  return observation ? Date.now() - observation.at : null
}

/** 观察是否仍然新鲜（存在、未作废、未超 TTL）。 */
export function isFresh(ttlMs) {
  if (!observation || observation.stale) return false
  return Date.now() - observation.at <= ttlMs
}

/**
 * 写操作前的观察门禁。
 * @param {number} ttlMs 观察有效期（毫秒）。
 * @param {string} toolName 触发门禁的工具名（用于报错提示）。
 * @returns 当前观察结果。
 * @throws 观察缺失 / 已作废 / 已过期时抛出带中文指引的错误。
 */
export function requireFreshObservation(ttlMs, toolName) {
  if (!observation) {
    throw new Error(
      `尚未观察桌面：请先调用 linux_screenshot 看清当前界面，再执行 ${toolName}。`,
    )
  }
  if (observation.stale) {
    throw new Error(
      `上次观察已作废（${toolName} 之后界面可能已经变化）：请重新调用 linux_screenshot。`,
    )
  }
  const age = Date.now() - observation.at
  if (age > ttlMs) {
    throw new Error(
      `观察快照已过期（约 ${Math.round(age / 1000)} 秒 > ${Math.round(ttlMs / 1000)} 秒）：请重新调用 linux_screenshot。`,
    )
  }
  return observation
}

/**
 * 把"图上像素"换算成屏幕绝对坐标。
 * @param {number} x 图上 X 像素。
 * @param {number} y 图上 Y 像素。
 * @param {{x:number,y:number}} origin 截图区域原点。
 * @param {number} scale 图上像素 → 屏幕像素的倍率（截图被缩小时 > 1）。
 */
export function toScreenPoint(x, y, origin, scale = 1) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    x: Math.round(origin.x + x * factor),
    y: Math.round(origin.y + y * factor),
  }
}
