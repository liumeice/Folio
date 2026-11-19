"""百度网盘 MCP 推送：把编译产物推到 /Folio/<版本号>/ 并建永久分享链接。

需求方规则（2026-11-19）：每次编译发版后推送五件套——
便携版主程序、GitHub release 的两个安装包、两个源代码包（tag 归档 zip/tar.gz）。

用法（通常经 netdisk-release.sh 调用；手动亦可）：
  BAIDU_NETDISK_ACCESS_TOKEN=*** <mcp-venv>/Scripts/python.exe -I scripts/netdisk_push.py
      [--no-share] <版本号> <本地文件1> [本地文件2 ...]

依赖百度网盘 MCP 服务（github.com/baidu-netdisk/mcp）：SSE 远程服务负责建目录/分享，
stdio 本地服务负责读盘上传。位置默认 NETDISK_MCP_DIR（可用同名环境变量覆盖）。

幂等口径（实测 2026-11-19，三条都是真踩出来的）：
- 远程 make_dir 对已存在目录不报错，而是新建"带时间后缀"的重名目录；
- file_list "/" 不一定列出根下目录（分页/过滤），存在性判断一律直接对目标目录查 errno；
- 上传同名文件会落成 "xxx(1).ext" 副本，所以网盘同名文件先比对：等大小=跳过，不等=中止；
- 所有响应嵌套 {"errno":0,"data":{...}}；SVIP 可用 period=0 建永久分享。
"""
import asyncio, json, os, sys

MCP_DIR = os.environ.get("NETDISK_MCP_DIR",
    r"D:\AIProject\mcp-servers\baidu-netdisk-mcp\src\baidu-netdisk")
UPLOAD_PY = os.path.join(MCP_DIR, ".venv", "Scripts", "python.exe")
UPLOAD_TOOL = os.path.join(MCP_DIR, "fileupload_tool.py")
TOKEN = os.environ.get("BAIDU_NETDISK_ACCESS_TOKEN") or sys.exit(
    "缺少环境变量 BAIDU_NETDISK_ACCESS_TOKEN（约每月到期，需重新 OAuth）")
SSE_URL = "https://mcp-pan.baidu.com/sse?access_token=" + TOKEN

if not os.path.isfile(UPLOAD_PY):
    sys.exit(f"找不到百度 MCP 服务端 venv：{UPLOAD_PY}（设 NETDISK_MCP_DIR 覆盖）")

from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client, StdioServerParameters


async def call(sess, tool, args):
    """返回 (errno, data)。data 取 {"data":{...}} 内层；无 data 字段时取整个响应体。"""
    res = await sess.call_tool(tool, args)
    txt = "\n".join(c.text for c in res.content if getattr(c, "type", "") == "text")
    try:
        d = json.loads(txt)
    except Exception:
        print(f"  {tool} 非JSON响应: {txt[:300]}")
        return -1, {}
    en = d.get("errno", -1)
    if en != 0:
        print(f"  {tool} errno={en}: {txt[:200]}")
    data = d.get("data", d)
    return en, data if isinstance(data, dict) else {}


async def main():
    args = sys.argv[1:]
    no_share = args[:1] == ["--no-share"]
    if no_share:
        args = args[1:]
    version, files = args[0], args[1:]
    vdir = f"/Folio/{version}"
    for f in files:
        if not os.path.isfile(f):
            sys.exit(f"本地文件不存在: {f}")

    async with sse_client(SSE_URL) as (r, w):
        async with ClientSession(r, w) as net:
            await net.initialize()

            # /Folio 根目录：直接查它的列表判存在（file_list "/" 不可靠）
            en = (await call(net, "file_list", {"dir": "/Folio"}))[0]
            if en != 0:
                print("建 /Folio:", (await call(net, "make_dir", {"path": "/Folio"}))[1])

            # 版本目录：从 /Folio 列表拿 fsid；没有才 make_dir
            _, root = await call(net, "file_list", {"dir": "/Folio"})
            fsid = next((str(it["fsid"]) for it in root.get("list", [])
                         if it.get("filename") == version), None)
            if not fsid:
                _, d = await call(net, "make_dir", {"path": vdir})
                fsid = str(d.get("fs_id") or "")
            if not fsid:
                sys.exit(f"拿不到 {vdir} 的 fsid")
            print(f"{vdir} fsid={fsid}")

            # 上传：网盘同名文件等大小跳过，不等大小中止（防 newcopy 副本）
            _, cur = await call(net, "file_list", {"dir": vdir})
            remote = {it["filename"]: int(it.get("size", -1)) for it in cur.get("list", [])}
            todo = []
            for f in files:
                name = os.path.basename(f)
                if name in remote:
                    if remote[name] == os.path.getsize(f):
                        print(f"跳过(网盘已有同大小): {name}")
                    else:
                        sys.exit(f"网盘同名文件大小不一致: {name} 本地{os.path.getsize(f)} "
                                 f"远端{remote[name]} —— 请人工确认后删除远端再重推")
                else:
                    todo.append(f)

            if todo:
                async with stdio_client(StdioServerParameters(
                        command=UPLOAD_PY, args=[UPLOAD_TOOL],
                        env=dict(os.environ, PYTHONUNBUFFERED="1"))) as (r2, w2):
                    async with ClientSession(r2, w2) as up:
                        await up.initialize()
                        for f in todo:
                            _, d = await call(up, "upload_file", {
                                "local_file_path": f, "remote_path": vdir})
                            print(f"上传 {os.path.basename(f)}: {d.get('status', '?')}")
                            if d.get("status") != "success":
                                sys.exit(f"上传失败: {d}")

            # 核对
            print("网盘核对:")
            _, lst = await call(net, "file_list", {"dir": vdir})
            for it in lst.get("list", []):
                print(f"  - {it['filename']}  {it['size']} bytes")

            # 永久分享链接
            if no_share:
                return
            en, d = await call(net, "file_sharelink_set", {
                "fsid_list": json.dumps([fsid]), "period": 0})
            if en == 0 and d.get("short_url"):
                print(f"分享链接: https://pan.baidu.com/s/1{d['short_url']} "
                      f"密码:{d.get('pwd')} 永久")
            else:
                print("分享创建异常:", d)

asyncio.run(main())
