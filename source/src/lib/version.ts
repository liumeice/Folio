/* 版本呈现的唯一出口。值由 vite define 注入（见 vite.config.ts）：
 *   正式版打包：release.sh 传 FOLIO_VERSION=主.次.修复.编译次数 → "0.2.0.43"
 *   开发/浏览器 mock：回落 "0.2.0-dev"（基线读自 tauri.conf.json）
 * declare 必须留在这里——tsc 不认识 define 注入的全局。 */
declare const __FOLIO_VERSION__: string;

export const APP_VERSION: string = __FOLIO_VERSION__;
export const IS_DEV: boolean = APP_VERSION.endsWith("-dev");
