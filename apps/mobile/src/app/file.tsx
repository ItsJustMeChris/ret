import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { Copy, FileWarning } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { imageType } from "@shared/files";
import { readText } from "@ret/lib/fileText";
import { hostName } from "@ret/state/hosts";
import { toast } from "@ret/state/toasts";
import { Empty, Icon, Mono, Spinner } from "../ui/primitives";
import { ThreadImage } from "../ui/ThreadImage";

type Loaded = { text: string } | { binary: true } | { large: number } | { error: string };

const LINE_H = 19;
const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/**
 * A file on a paired computer, read through its agent (the desktop's Code mode file pane reads the
 * same way): text with line numbers, at the line a reference pointed to; images shown whole.
 */
export default function FileScreen() {
  const { path, host, line } = useLocalSearchParams<{ path: string; host: string; line?: string }>();
  const name = path.split(/[\\/]/).pop() || path;
  const dir = path.slice(0, path.length - name.length).replace(/[\\/]$/, "");
  const image = !!imageType(path);
  const [file, setFile] = useState<Loaded | null>(null);
  const list = useRef<FlatList<string>>(null);
  const target = line ? Math.max(1, Number(line)) : null;

  useEffect(() => {
    if (image) return;
    let live = true;
    readText(path, host).then(
      (r) => live && setFile(r),
      (err: Error) => live && setFile({ error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [path, host, image]);

  const lines = useMemo(() => (file && "text" in file ? file.text.replace(/\r\n?/g, "\n").split("\n") : []), [file]);
  const gutter = String(lines.length).length;

  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View className="max-w-[260px] items-center">
              <Text numberOfLines={1} className="text-[16px] font-semibold text-text">
                {name}
              </Text>
              <Text numberOfLines={1} ellipsizeMode="head" className="text-[12px] text-text-3">
                {[dir, hostName(host)].filter(Boolean).join(" · ")}
              </Text>
            </View>
          ),
          headerRight: () =>
            file && "text" in file ? (
              <Pressable
                hitSlop={10}
                accessibilityLabel="Copy"
                onPress={() => {
                  void Clipboard.setStringAsync(file.text);
                  toast("Copied");
                }}
              >
                <Icon icon={Copy} size={18} colorClassName="accent-text-2" />
              </Pressable>
            ) : null,
        }}
      />
      {image ? (
        <View className="flex-1 items-center justify-center p-4">
          <ThreadImage path={path} host={host} />
        </View>
      ) : !file ? (
        <View className="flex-1 items-center justify-center">
          <Spinner colorClassName="accent-text-3" />
        </View>
      ) : "error" in file ? (
        <Empty icon={FileWarning} title="Couldn't open it">
          {file.error}
        </Empty>
      ) : "binary" in file ? (
        <Empty icon={FileWarning} title="Not a text file">
          Open it on your computer.
        </Empty>
      ) : "large" in file ? (
        <Empty icon={FileWarning} title="Too big to show here">
          {fmtSize(file.large)}. Open it on your computer.
        </Empty>
      ) : (
        <FlatList
          ref={list}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          initialNumToRender={80}
          // Lines wrap, so their heights vary: jump close to the line, then land on it.
          onLayout={() => {
            if (target && target > 1) setTimeout(() => list.current?.scrollToIndex({ index: Math.min(target, lines.length) - 1, viewPosition: 0.3, animated: false }), 0);
          }}
          onScrollToIndexFailed={(info) => {
            list.current?.scrollToOffset({ offset: info.index * LINE_H, animated: false });
            setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.3, animated: false }), 50);
          }}
          renderItem={({ item, index }) => (
            <View className={`flex-row ${target === index + 1 ? "bg-accent-soft" : ""}`}>
              <Mono className="pr-2.5 text-right text-[12px] text-text-3" style={{ width: gutter * 7.5 + 18, lineHeight: LINE_H }}>
                {index + 1}
              </Mono>
              <Mono selectable className="flex-1 pr-3 text-[12px] text-text" style={{ lineHeight: LINE_H }}>
                {item || " "}
              </Mono>
            </View>
          )}
          contentContainerClassName="py-2"
        />
      )}
    </View>
  );
}
