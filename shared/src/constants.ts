export const APP_PACKAGE = "com.netease.uuremote";
export const API_BASE = "https://api.nrd.nie.163.com";
export const API_HOST = "api.nrd.nie.163.com";
/**
 * 冒充的安卓客户端版本，作为 `X-Param-VC` / `X-Param-VN` 头参与接口签名。
 *
 * UU 服务端会据此判断“控制端版本是否过低”（新版返回 code 2007
 * “控制端版本较低，请更新到最新版后再试”，HTTP 400，发生在 /api/v1/room/join 阶段）。
 * 所以这两个值必须跟官方安卓端最新版保持一致，且 VC 与 VN 要成对：
 *   VC = 主版本*100000 + 次版本*1000 + 修订号
 * 取证办法：下载官方 APK（https://api.nrd.nie.163.com/api/v1/release/dl/2 会 302
 * 到 uuyc_<版本>.apk），读 AndroidManifest 的 versionName / versionCode。
 * 2026-11-25 实测官方 APK 为 4.48.2 / 448002。
 */
export const VERSION_CODE = "448002";
export const VERSION_NAME = "4.48.2";
export const APP_SIGNING_KEY = "alWiSzXZTLu3WfFnw13uBru3";

export const DEVICE_GROUPS_PATH = "/api/v1/device/groups/of/my";
