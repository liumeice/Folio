/* 版本注入策略 v2（2026-11-16）：
 * Tauri 的 version 槽强制 semver 三段，而 PE FILEVERSION 支持四段「主.次.修复.编译次数」。
 * 不能另起一份 winres 资源（与 tauri-winres 的 VERSION 块重复 → CVTRES 1100/LNK1123）；
 * 正确姿势是让 tauri_build 先生成 OUT_DIR/resource.rc，就地改掉四行版本号，再用 rc.exe
 * 重新编到同一路径的 resource.lib（tauri 的 link-arg 指向同一文件，图标/manifest 不丢）。
 * FOLIO_VERSION 未设（cargo check / tauri dev）时完全跳过，构建行为与从前一致。 */
fn main() {
    tauri_build::build();
    println!("cargo:rerun-if-env-changed=FOLIO_VERSION");
    println!("cargo:rerun-if-changed=../.build-version");

    // 版本来源优先级（2026-11-16 发号改造）：FOLIO_VERSION 环境变量（显式指定）→
    // ../.build-version（tauri build 的 beforeBuildCommand 每次经 scripts/bump-build.cjs 发放，
    // 任何入口/任何 agent 实例自动累号）→ 两者皆无（cargo check / tauri dev）跳过，行为如旧。
    #[cfg(windows)]
    let ver: Option<String> = std::env::var("FOLIO_VERSION").ok().or_else(|| {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.build-version"),
        )
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    });

    #[cfg(windows)]
    if let Some(ver) = ver {
        let mut parts: Vec<u64> = ver.split('.').map(|s| s.parse().unwrap_or(0)).collect();
        parts.resize(4, 0);
        let [maj, min, fix, bld] = <[u64; 4]>::try_from(parts).unwrap();
        let quad = format!("{maj}, {min}, {fix}, {bld}");

        let rc = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("resource.rc");
        if !rc.exists() {
            println!("cargo:warning=未找到 tauri 生成的 resource.rc，跳过四段版本注入（{ver} 仅进前端显示）");
            return;
        }
        let text = std::fs::read_to_string(&rc).expect("读 resource.rc 失败");
        let patched: Vec<String> = text
            .lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("FILEVERSION ") {
                    format!("FILEVERSION {quad}")
                } else if t.starts_with("PRODUCTVERSION ") {
                    format!("PRODUCTVERSION {quad}")
                } else if t.starts_with("VALUE \"FileVersion\"") {
                    format!("VALUE \"FileVersion\", \"{ver}\"")
                } else if t.starts_with("VALUE \"ProductVersion\"") {
                    format!("VALUE \"ProductVersion\", \"{ver}\"")
                } else {
                    l.to_string()
                }
            })
            .collect();
        std::fs::write(&rc, patched.join("\n") + "\n").expect("写 resource.rc 失败");

        // rc.exe 由 cc 的 VS 注册表探测拿到（含 rc 编译所需 env）
        let target = std::env::var("TARGET").unwrap();
        let tool = cc::windows_registry::find_tool(&target, "rc.exe")
            .unwrap_or_else(|| panic!("未找到 rc.exe：需要 VS Build Tools 或 Visual Studio C++ 负载"));
        let lib = rc.with_extension("lib"); // 与 tauri link-arg 同路径：原地替换
        let out = std::process::Command::new(tool.path())
            .args(["/nologo", "/fo"])
            .arg(&lib)
            .arg(&rc)
            .envs(tool.get_envs())
            .output()
            .expect("运行 rc.exe 失败");
        if !out.status.success() {
            panic!("rc.exe 重编版本资源失败：{}", String::from_utf8_lossy(&out.stderr));
        }
        // 让指纹随编译次数变化，确保 cargo 必然重链 exe
        println!("cargo:FolioEmbeddedVersion={ver}");
    }
}
