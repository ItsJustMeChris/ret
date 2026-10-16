import { Stack, useLocalSearchParams } from "expo-router";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react-native";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { fsClient } from "@ret/rpc/client";
import { hostName } from "@ret/state/hosts";
import { openFile, openFolder } from "../files";
import { Empty, Icon, Spinner } from "../ui/primitives";

type Entry = { name: string; dir: boolean };

/** A folder on a paired computer, listed through its agent (as the desktop's Code mode explorer). */
export default function FilesScreen() {
  const { path, host } = useLocalSearchParams<{ path: string; host: string }>();
  const [entries, setEntries] = useState<Entry[] | { error: string } | null>(null);
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

  useEffect(() => {
    let live = true;
    fsClient(host)
      .request("fs/readDirectory", { path })
      .then(
        (res) => {
          if (!live) return;
          const list = (res as { entries: { fileName: string; isDirectory: boolean }[] }).entries
            .map((e) => ({ name: e.fileName, dir: e.isDirectory }))
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
          setEntries(list);
        },
        (err: Error) => live && setEntries({ error: err.message }),
      );
    return () => {
      live = false;
    };
  }, [path, host]);

  const child = (n: string) => `${path.replace(/[\\/]+$/, "")}${sep}${n}`;

  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View className="max-w-[260px] items-center">
              <Text numberOfLines={1} className="text-[16px] font-semibold text-text">
                {name}
              </Text>
              <Text numberOfLines={1} className="text-[12px] text-text-3">
                {hostName(host)}
              </Text>
            </View>
          ),
        }}
      />
      {!entries ? (
        <View className="flex-1 items-center justify-center">
          <Spinner colorClassName="accent-text-3" />
        </View>
      ) : "error" in entries ? (
        <Empty icon={FolderOpen} title="Couldn't open it">
          {entries.error}
        </Empty>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.name}
          ListEmptyComponent={<Empty icon={FolderOpen} title="Empty folder" />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => (item.dir ? openFolder(child(item.name), host) : openFile(child(item.name), host))}
              className="mx-2 min-h-[44px] flex-row items-center gap-3 rounded-lg px-3 active:bg-bg-3"
            >
              <Icon icon={item.dir ? Folder : File} size={16} colorClassName={item.dir ? "accent-accent" : "accent-text-3"} />
              <Text numberOfLines={1} className={`flex-1 text-[15px] ${item.name.startsWith(".") ? "text-text-3" : "text-text"}`}>
                {item.name}
              </Text>
              {item.dir && <Icon icon={ChevronRight} size={15} colorClassName="accent-text-3" />}
            </Pressable>
          )}
          contentContainerClassName="py-2"
        />
      )}
    </View>
  );
}
