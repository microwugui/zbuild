// 1:1 移植自 esbuild internal/helpers/timer.go（v0.28.2，f6058f83）
// Go 的 time.Now() 用于测量；TS 侧注入一个 now()（默认 Date.now），
// 测试里用固定 now 保证 0ms 结果与 Go 探针逐字一致。

import { Log, Msg, MsgData, MsgKind } from "../logger/logger.ts";
import { AddMsgID } from "../logger/logger.ts";
import { MsgID_None } from "../logger/msg_ids.ts";

/** Go: type timerData (timer.go:16) */
interface timerData {
  time: number;
  name: string;
  isEnd: boolean;
}

/** Go: type Timer struct (timer.go:12) */
export class Timer {
  data: timerData[] = [];
  /** 注入的时间源（Go 是 time.Now；默认 Date.now） */
  now: () => number = () => Date.now();

  /** Go: func (t *Timer) Begin(name string) (timer.go:23) */
  Begin(name: string): void {
    this.data.push({ name, time: this.now(), isEnd: false });
  }

  /** Go: func (t *Timer) End(name string) (timer.go:32) */
  End(name: string): void {
    this.data.push({ name, time: this.now(), isEnd: true });
  }

  /** Go: func (t *Timer) Fork() *Timer (timer.go:42) */
  Fork(): Timer | null {
    const t = new Timer();
    t.now = this.now;
    return t;
  }

  /** Go: func (t *Timer) Join(other *Timer) (timer.go:49) */
  Join(other: Timer | null): void {
    if (other !== null) this.data.push(...other.data);
  }

  /** Go: func (t *Timer) Log(log logger.Log) (timer.go:57) */
  Log(log: Log): void {
    const notes: MsgData[] = [];
    const stack: { item: timerData; index: number }[] = [];
    let indent = 0;
    for (const item of this.data) {
      if (!item.isEnd) {
        stack.push({ item, index: notes.length });
        const m = new MsgData();
        m.DisableMaximumWidth = true;
        notes.push(m);
        indent++;
      } else {
        indent--;
        const top = stack[stack.length - 1];
        stack.pop();
        if (item.name !== top.item.name) throw new Error("Internal error");
        notes[top.index].Text = "  ".repeat(indent) + top.item.name + ": " + (item.time - top.item.time) + "ms";
      }
    }
    const msg = new Msg();
    msg.Kind = MsgKind.Info;
    msg.Data.Text = "Timing information (times may not nest hierarchically due to parallelism)";
    msg.Notes = notes;
    AddMsgID(log, MsgID_None, msg);
  }
}
