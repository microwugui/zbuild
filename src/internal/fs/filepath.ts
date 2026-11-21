// 1:1 移植自 esbuild internal/fs/filepath.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：路径纯判定函数。真值表由 Go 探针固化在
// testdata/fs-filepath-go.json。

const reservedNames = [
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/** Go: func isReservedName(path string) bool (filepath.go:65) */
export function isReservedName(path: string): boolean {
  if (path.length === 0) return false;
  const lower = path.toLowerCase();
  for (const reserved of reservedNames) {
    if (lower === reserved.toLowerCase()) return true;
  }
  return false;
}

/** Go: func isSlash(c uint8) bool (filepath.go:50) */
export function isSlash(c: number): boolean {
  return c === 0x5c || c === 0x2f;
}

/** Go: type lazybuf struct (filepath.go:297) */
export class lazybuf {
  path: string = "";
  volAndPath: string = "";
  buf: number[] | null = null;
  w: number = 0;
  volLen: number = 0;

  /** Go: func (b *lazybuf) index(i int) byte (filepath.go:305) */
  index(i: number): number {
    if (this.buf !== null) return this.buf[i];
    return this.path.charCodeAt(i);
  }

  /** Go: func (b *lazybuf) append(c byte) (filepath.go:312) */
  append(c: number): void {
    if (this.buf === null) {
      if (this.w < this.path.length && this.path.charCodeAt(this.w) === c) {
        this.w++;
        return;
      }
      this.buf = [];
      for (let i = 0; i < this.path.length; i++) this.buf[i] = this.path.charCodeAt(i);
    }
    this.buf[this.w] = c;
    this.w++;
  }

  /** Go: func (b *lazybuf) string() string (filepath.go:325) */
  string(): string {
    if (this.buf === null) return this.volAndPath.slice(0, this.volLen + this.w);
    return this.volAndPath.slice(0, this.volLen) + String.fromCharCode(...this.buf.slice(0, this.w));
  }
}

/** Go: type goFilepath (filepath.go) —— 只落本批用到的 isWindows */
export class goFilepath {
  isWindows: boolean = false;
  pathSeparator: number = 0x2f; // '/'
  cwd: string = "";

  constructor(isWindows: boolean = false, pathSeparator?: number) {
    this.isWindows = isWindows;
    this.pathSeparator = pathSeparator !== undefined ? pathSeparator : (isWindows ? 0x5c : 0x2f);
  }

  /** Go: func (fp goFilepath) volumeNameLen(path string) int (filepath.go:114) */
  volumeNameLen(path: string): number {
    if (!this.isWindows) return 0;
    if (path.length < 2) return 0;
    const c = path.charCodeAt(0);
    if (path[1] === ":" && ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a))) return 2;
    const l = path.length;
    if (l >= 5 && isSlash(path.charCodeAt(0)) && isSlash(path.charCodeAt(1)) && !isSlash(path.charCodeAt(2)) && path[2] !== ".") {
      for (let n = 3; n < l - 1; n++) {
        if (isSlash(path.charCodeAt(n))) {
          n++;
          if (!isSlash(path.charCodeAt(n))) {
            if (path[n] === ".") break;
            for (; n < l; n++) { if (isSlash(path.charCodeAt(n))) break; }
            return n;
          }
          break;
        }
      }
    }
    return 0;
  }

  /** Go: func (fp goFilepath) clean(path string) string (filepath.go:365) */
  clean(path: string): string {
    const originalPath = path;
    const volLen = this.volumeNameLen(path);
    path = path.slice(volLen);
    if (path === "") {
      if (volLen > 1 && originalPath[1] !== ":") return this.fromSlash(originalPath);
      return originalPath + ".";
    }
    const rooted = this.isPathSeparator(path.charCodeAt(0));
    const n = path.length;
    const out = new lazybuf();
    out.path = path; out.volAndPath = originalPath; out.volLen = volLen;
    let r = 0, dotdot = 0;
    if (rooted) { out.append(this.pathSeparator); r = 1; dotdot = 1; }
    while (r < n) {
      if (this.isPathSeparator(path.charCodeAt(r))) { r++; }
      else if (path[r] === "." && (r + 1 === n || this.isPathSeparator(path.charCodeAt(r + 1)))) { r++; }
      else if (path[r] === "." && path[r + 1] === "." && (r + 2 === n || this.isPathSeparator(path.charCodeAt(r + 2)))) {
        r += 2;
        if (out.w > dotdot) {
          out.w--;
          while (out.w > dotdot && !this.isPathSeparator(out.index(out.w))) out.w--;
        } else if (!rooted) {
          if (out.w > 0) out.append(this.pathSeparator);
          out.append(0x2e); out.append(0x2e);
          dotdot = out.w;
        }
      } else {
        if ((rooted && out.w !== 1) || (!rooted && out.w !== 0)) out.append(this.pathSeparator);
        while (r < n && !this.isPathSeparator(path.charCodeAt(r))) { out.append(path.charCodeAt(r)); r++; }
      }
    }
    if (out.w === 0) out.append(0x2e);
    return this.fromSlash(out.string());
  }

  /** Go: func (fp goFilepath) base(path string) string (filepath.go:451) */
  base(path: string): string {
    if (path === "") return ".";
    while (path.length > 0 && this.isPathSeparator(path.charCodeAt(path.length - 1))) path = path.slice(0, -1);
    path = path.slice(this.volumeNameLen(path));
    let i = path.length - 1;
    while (i >= 0 && !this.isPathSeparator(path.charCodeAt(i))) i--;
    if (i >= 0) path = path.slice(i + 1);
    if (path === "") return String.fromCharCode(this.pathSeparator);
    return path;
  }

  /** Go: func (fp goFilepath) dir(path string) string (filepath.go:482) */
  dir(path: string): string {
    const vol = path.slice(0, this.volumeNameLen(path));
    let i = path.length - 1;
    while (i >= vol.length && !this.isPathSeparator(path.charCodeAt(i))) i--;
    const dir = this.clean(path.slice(vol.length, i + 1));
    if (dir === "." && vol.length > 2) return vol;
    return vol + dir;
  }

  /** Go: func (fp goFilepath) volumeName(path string) string (filepath.go:443) */
  volumeName(path: string): string {
    return path.slice(0, this.volumeNameLen(path));
  }

  /** Go: func (fp goFilepath) isUNC(path string) bool (filepath.go:565) */
  isUNC(path: string): boolean {
    return this.volumeNameLen(path) > 2;
  }

  /** Go: func (fp goFilepath) joinNonEmpty(elem []string) string (filepath.go:539) */
  joinNonEmpty(elem: string[]): string {
    if (elem[0].length === 2 && elem[0][1] === ":") {
      let i = 1;
      for (; i < elem.length; i++) { if (elem[i] !== "") break; }
      return this.clean(elem[0] + elem.slice(i).join(String.fromCharCode(this.pathSeparator)));
    }
    return this.clean(elem.join(String.fromCharCode(this.pathSeparator)));
  }

  /** Go: func (fp goFilepath) join(elem []string) string (filepath.go:516) */
  join(elem: string[]): string {
    for (let i = 0; i < elem.length; i++) {
      if (elem[i] !== "") {
        if (this.isWindows) return this.joinNonEmpty(elem.slice(i));
        return this.clean(elem.slice(i).join(String.fromCharCode(this.pathSeparator)));
      }
    }
    return "";
  }

  /** Go: func (fp goFilepath) abs(path string) (string, error) (filepath.go:101) */
  abs(path: string): { value: string; err: string | null } {
    if (this.isAbs(path)) return { value: this.clean(path), err: null };
    return { value: this.join([this.cwd, path]), err: null };
  }

  /** Go: func (fp goFilepath) rel(basepath, targpath string) (string, error) (filepath.go:576) */
  rel(basepath: string, targpath: string): { value: string; err: string | null } {
    const err = (): { value: string; err: string | null } => ({ value: "", err: `Rel: can't make ${targpath} relative to ${basepath}` });
    const baseVol = this.volumeName(basepath);
    const targVol = this.volumeName(targpath);
    let base = this.clean(basepath);
    let targ = this.clean(targpath);
    if (this.sameWord(targ, base)) return { value: ".", err: null };
    base = base.slice(baseVol.length);
    targ = targ.slice(targVol.length);
    if (base === ".") base = "";
    const baseSlashed = base.length > 0 && base.charCodeAt(0) === this.pathSeparator;
    const targSlashed = targ.length > 0 && targ.charCodeAt(0) === this.pathSeparator;
    if (baseSlashed !== targSlashed || !this.sameWord(baseVol, targVol)) return err();
    const bl = base.length, tl = targ.length;
    let b0 = 0, bi = 0, t0 = 0, ti = 0;
    for (;;) {
      while (bi < bl && base.charCodeAt(bi) !== this.pathSeparator) bi++;
      while (ti < tl && targ.charCodeAt(ti) !== this.pathSeparator) ti++;
      if (!this.sameWord(targ.slice(t0, ti), base.slice(b0, bi))) break;
      if (bi < bl) bi++;
      if (ti < tl) ti++;
      b0 = bi; t0 = ti;
    }
    if (base.slice(b0, bi) === "..") return err();
    const sep = String.fromCharCode(this.pathSeparator);
    if (b0 !== bl) {
      let seps = 0;
      for (const ch of base.slice(b0, bl)) if (ch === sep) seps++;
      let out = "..";
      for (let i = 0; i < seps; i++) out += sep + "..";
      if (t0 !== tl) out += sep + targ.slice(t0);
      return { value: out, err: null };
    }
    return { value: targ.slice(t0), err: null };
  }

  /** Go: func (fp goFilepath) isAbs(path string) bool (filepath.go:78) */
  isAbs(path: string): boolean {
    if (!this.isWindows) return path.startsWith("/");
    if (isReservedName(path)) return true;
    const l = this.volumeNameLen(path);
    if (l === 0) return false;
    path = path.slice(l);
    if (path === "") return false;
    return isSlash(path.charCodeAt(0));
  }

  /** Go: func (fp goFilepath) isPathSeparator(c uint8) bool (filepath.go:109) */
  isPathSeparator(c: number): boolean {
    return c === 0x2f /* '/' */ || (this.isWindows && c === 0x5c /* '\\' */);
  }

  /** Go: func (fp goFilepath) fromSlash(path string) string (filepath.go:335) */
  fromSlash(path: string): string {
    if (!this.isWindows) return path;
    return path.replaceAll("/", "\\");
  }

  /** Go: func (fp goFilepath) sameWord(a, b string) bool (filepath.go:644) */
  sameWord(a: string, b: string): boolean {
    if (!this.isWindows) return a === b;
    return a.toLowerCase() === b.toLowerCase();
  }

  /** Go: func (fp goFilepath) ext(path string) string (filepath.go:500) */
  ext(path: string): string {
    for (let i = path.length - 1; i >= 0 && !this.isPathSeparator(path.charCodeAt(i)); i--) {
      if (path[i] === ".") return path.slice(i);
    }
    return "";
  }
}

/** Go: os.Lstat / os.Readlink 的最小子集（注入以便测试用真实 fs 或 mock） */
export interface SymlinkFS {
  lstat(path: string): { isSymlink: boolean; isDir: boolean; err: boolean };
  readlink(path: string): { target: string; err: boolean };
}

/**
 * Go: func (fp goFilepath) evalSymlinks(path string) (string, error) (filepath.go:159)
 * 逐字节证据 tools/go/tmpgen_symlink_test.go → testdata/eval-symlinks-go.json（SHA 7e64bb5e…），5 场景。
 * 用注入的 SymlinkFS 复刻 Go 的 lstat/readlink 路径解析（含 . / .. / 相对·绝对 symlink / 链），
 * 不绑定具体平台 syscall；失败返回 { path:"", ok:false }。
 */
export function evalSymlinks(
  fp: goFilepath,
  path: string,
  sfs: SymlinkFS,
): { path: string; ok: boolean } {
  const sep = String.fromCharCode(fp.pathSeparator);
  const isSep = (c: string): boolean => c === "/" || (fp.isWindows && c === "\\");
  let volLen = fp.volumeNameLen(path);
  if (volLen < path.length && isSep(path[volLen])) volLen++;
  let vol = path.slice(0, volLen);
  let dest = vol;
  let linksWalked = 0;
  let start = volLen, end = volLen;

  while (start < path.length) {
    while (start < path.length && isSep(path[start])) start++;
    end = start;
    while (end < path.length && !isSep(path[end])) end++;
    const isWindowsDot = fp.isWindows && path.slice(fp.volumeNameLen(path)) === ".";
    if (end === start) break;
    if (path.slice(start, end) === "." && !isWindowsDot) { start = end; continue; }
    if (path.slice(start, end) === "..") {
      let r = dest.length - 1;
      while (r >= volLen && !isSep(dest[r])) r--;
      if (r < volLen || dest.slice(r + 1) === "..") {
        if (dest.length > volLen) dest += sep;
        dest += "..";
      } else {
        dest = dest.slice(0, r);
      }
      start = end;
      continue;
    }
    if (dest.length > fp.volumeNameLen(dest) && !isSep(dest[dest.length - 1])) dest += sep;
    dest += path.slice(start, end);
    const st = sfs.lstat(dest);
    if (st.err) return { path: "", ok: false };
    if (!st.isSymlink) {
      if (!st.isDir && end < path.length) return { path: "", ok: false }; // ENOTDIR
      start = end;
      continue;
    }
    linksWalked++;
    if (linksWalked > 255) return { path: "", ok: false };
    const link = sfs.readlink(dest).target;
    if (isWindowsDot && !(link.length > 0 && isSep(link[0]))) break;
    path = link + path.slice(end);
    const v = fp.volumeNameLen(link);
    if (v > 0) {
      let vv = v;
      if (vv < link.length && isSep(link[vv])) vv++;
      vol = link.slice(0, vv);
      dest = vol;
      end = vol.length;
    } else if (link.length > 0 && isSep(link[0])) {
      dest = link.slice(0, 1);
      end = 1;
    } else {
      let r = dest.length - 1;
      while (r >= volLen && !isSep(dest[r])) r--;
      dest = r < volLen ? vol : dest.slice(0, r);
      end = 0;
    }
    start = end; // Go for 循环后置语句：start = end
  }
  return { path: fp.clean(dest), ok: true };
}

