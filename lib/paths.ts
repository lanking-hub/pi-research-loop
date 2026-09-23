import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 包内资源目录定位。
 *
 * 扩展和 lib 都是 jiti 加载的 TS，import.meta.url 有效
 * （pi 自带示例 examples/extensions/dynamic-resources/index.ts 同样是这个写法）。
 *
 * 收敛到一处是有意为之：import.meta.url 是本项目唯一的路径依赖点，
 * 将来若要改成「资源内嵌进扩展」以彻底去掉路径依赖，只改这一个文件。
 */

/** 包根目录（本文件在 <pkg>/lib/ 下） */
export function packageRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** 模板目录：/rl init 从这里拷文件到项目 */
export function templatesDir(): string {
	return join(packageRoot(), "templates");
}

/** 服务器脚本目录：/rl setup 从这里上传 run_exp.sh / run_status.sh */
export function serverDir(): string {
	return join(packageRoot(), "server");
}
