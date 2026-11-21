package main

// 一次性探针：Log.AddError/AddID/AddErrorWithNotes/AddIDWithNotes/AddMsgID/allowOverride/NewDeferLog
// 用法: go run ./tmplogapi <spec.json>；输出 \x00CASE:name + hex/stderr 或 deferlog 摘要

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"

	"github.com/evanw/esbuild/internal/logger"
)

type spec struct {
	Contents  string         `json:"contents"`
	LogLevel  int            `json:"logLevel"`
	Overrides map[string]int `json:"overrides"`
	Cases     []struct {
		Name   string   `json:"name"`
		API    string   `json:"api"`
		Start  int      `json:"start"`
		Len    int      `json:"len"`
		Text   string   `json:"text"`
		ID     int      `json:"id"`
		Kind   int      `json:"kind"`
		Plugin string   `json:"plugin"`
		Notes  []string `json:"notes"`
	} `json:"cases"`
	Defer []struct {
		Name      string         `json:"name"`
		Kind      int            `json:"kind"`
		Overrides map[string]int `json:"overrides"`
		Msgs      []struct {
			Kind int    `json:"kind"`
			ID   int    `json:"id"`
			Text string `json:"text"`
		} `json:"msgs"`
	} `json:"defer"`
}

func overrides(m map[string]int) map[logger.MsgID]logger.LogLevel {
	if m == nil {
		return nil
	}
	out := make(map[logger.MsgID]logger.LogLevel)
	for k, v := range m {
		var id int
		fmt.Sscanf(k, "%d", &id)
		out[logger.MsgID(id)] = logger.LogLevel(v)
	}
	return out
}

func main() {
	data, _ := ioutil.ReadFile(os.Args[1])
	var sp spec
	if err := json.Unmarshal(data, &sp); err != nil {
		panic(err)
	}
	src := &logger.Source{Contents: sp.Contents}
	src.PrettyPaths.Rel = "<stdin>"
	tr := logger.MakeLineColumnTracker(src)
	trp := &tr

	for _, c := range sp.Cases {
		old := os.Stderr
		r, w, _ := os.Pipe()
		os.Stderr = w
		log := logger.NewStderrLog(logger.OutputOptions{
			IncludeSource: true,
			Color:         logger.ColorNever,
			LogLevel:      logger.LogLevel(sp.LogLevel),
			Overrides:     overrides(sp.Overrides),
		})
		rng := logger.Range{Loc: logger.Loc{Start: int32(c.Start)}, Len: int32(c.Len)}
		var notes []logger.MsgData
		for _, n := range c.Notes {
			notes = append(notes, logger.MsgData{Text: n})
		}
		switch c.API {
		case "error":
			log.AddError(trp, rng, c.Text)
		case "id":
			log.AddID(logger.MsgID(c.ID), logger.MsgKind(c.Kind), trp, rng, c.Text)
		case "error-notes":
			log.AddErrorWithNotes(trp, rng, c.Text, notes)
		case "id-notes":
			log.AddIDWithNotes(logger.MsgID(c.ID), logger.MsgKind(c.Kind), trp, rng, c.Text, notes)
		case "msg-id":
			msg := logger.Msg{Kind: logger.MsgKind(c.Kind), PluginName: c.Plugin}
			msg.Data = tr.MsgData(rng, c.Text)
			msg.Notes = notes
			log.AddMsgID(logger.MsgID(c.ID), msg)
		}
		log.Done()
		w.Close()
		os.Stderr = old
		b, _ := ioutil.ReadAll(r)
		fmt.Printf("\x00CASE:%s\n%s\n", c.Name, hex.EncodeToString(b))
	}

	for _, d := range sp.Defer {
		log := logger.NewDeferLog(logger.DeferLogKind(d.Kind), overrides(d.Overrides))
		for _, m := range d.Msgs {
			msg := logger.Msg{Kind: logger.MsgKind(m.Kind), ID: logger.MsgID(m.ID)}
			msg.Data.Text = m.Text
			log.AddMsg(msg)
		}
		peek := log.Peek()
		out := fmt.Sprintf("hasErrors=%v peek=%d done=", log.HasErrors(), len(peek))
		for i, m := range log.Done() {
			if i > 0 {
				out += ";"
			}
			out += fmt.Sprintf("%d/%d/%s", int(m.Kind), int(m.ID), m.Data.Text)
		}
		fmt.Printf("\x00CASE:%s\n%s\n", d.Name, hex.EncodeToString([]byte(out)))
	}
}
