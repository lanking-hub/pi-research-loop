// 用 codex 私钥先探服务器是否允许密码认证（读 sshd 实际配置），再走一遍密码路径
import { Client } from "ssh2";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
setTimeout(() => { console.log("HARD_TIMEOUT_20S"); process.exit(9); }, 20000).unref();
const conn = new Client();
conn.on("ready", () => {
  conn.exec("sshd -T 2>/dev/null | grep -iE 'passwordauthentication|kbdinteractive|pubkeyauthentication' ; echo --- ; getent passwd $(whoami) | cut -d: -f1", (err, stream) => {
    if (err) { console.log("EXEC_ERR", err.message); process.exit(1); }
    let out = "";
    stream.on("data", (d) => (out += d));
    stream.on("close", () => { console.log(out.trim()); conn.end(); process.exit(0); });
  });
})
.on("error", (e) => { console.log("CONN_ERR:", e.message); process.exit(2); })
.connect({
  host: "172.18.65.195", port: 22, username: "sheng_hao_xuan_2025",
  privateKey: readFileSync(homedir() + "/.ssh/codex_amax_ed25519", "utf8"), readyTimeout: 15000,
});
