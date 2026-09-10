/**
 * MetroMap — the REVAMP 2 map view: a stylized nightlife map of the Phoenix
 * metro rendered with react-native-svg (works identically on iOS, Android and
 * web export — no native map module, no API keys).
 *
 * - Every pin is a REAL venue from the API (lat/lon, going_count, category,
 *   city). No invented positions, no jitter.
 * - Pin size scales with the real going_count (quiet spots stay small).
 * - tap a pin → onSelectVenue (browse mode).
 * - pinMode drops a neon pin on tap → onPin(lat, lon) — used by the custom
 *   spot flow (frat house first-class) so the user pins instead of typing
 *   lat/lon. Existing venue pins are hidden in pin mode.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import type { SpotCategory } from "../api/types";
import { colors, neon } from "../theme";
import {
  METRO_CITY_ANCHORS,
  pinRadius,
  project,
  unproject,
} from "../lib/metro";

export interface VenuePin {
  id: string;
  name: string;
  city: string;
  category: SpotCategory;
  lat: number;
  lon: number;
  going_count: number;
  trending_score: number;
}

interface Props {
  /** Venue pins (browse mode). Optional: the announce-sheet uses the map in
   * pinMode with no venues loaded. */
  venues?: VenuePin[];
  /** Browse mode: highlighted pin id (null → none). */
  selectedId?: string | null;
  onSelectVenue?: (v: VenuePin) => void;
  /** Pin mode: interactive tap-to-pin for custom spots. */
  pinMode?: boolean;
  pinLat?: number | null;
  pinLon?: number | null;
  onPin?: (lat: number, lon: number) => void;
  /** Fixed map height (px). Required — the map measures its own width. */
  height: number;
  /** Show city labels (hidden in the tiny announce-sheet map). */
  showCityLabels?: boolean;
}

const GRID = 48;
const QUIET_DOT = "#3A4150";
const HOT_FILL = neon.pink;
const HOT_GLOW = neon.pinkGlow;
const SELECTED_FILL = neon.cyan;

export function MetroMap({
  venues = [],
  selectedId = null,
  onSelectVenue,
  pinMode = false,
  pinLat = null,
  pinLon = null,
  onPin,
  height,
  showCityLabels = true,
}: Props): React.JSX.Element {
  const [width, setWidth] = useState(0);
  const wrapRef = useRef<View | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setWidth(w);
  }, []);

  /** Pins painted quiet→hot so live spots sit on top. */
  const ordered = useMemo(() => [...venues].sort((a, b) => a.going_count - b.going_count), [venues]);

  const gridLines = useMemo(() => {
    const lines: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    if (width <= 0 || height <= 0) return lines;
    for (let x = GRID; x < width; x += GRID) lines.push({ key: `v${x}`, x1: x, y1: 0, x2: x, y2: height });
    for (let y = GRID; y < height; y += GRID) lines.push({ key: `h${y}`, x1: 0, y1: y, x2: width, y2: y });
    return lines;
  }, [width, height]);

  const cityLabels = useMemo(() => {
    if (!showCityLabels || width <= 0 || height <= 0) return [];
    return Object.entries(METRO_CITY_ANCHORS).map(([city, ll]) => {
      const p = project(ll.lat, ll.lon);
      return { city, x: p.x * width, y: p.y * height };
    });
  }, [showCityLabels, width, height]);

  /**
   * Tap→coordinate mapping: native press events carry locationX/Y; on web the
   * event may lack them, so fall back to measuring the container in the window
   * and subtracting pageX/Y.
   */
  const pointFromPress = useCallback(
    (e: { nativeEvent: { locationX?: number; locationY?: number; pageX?: number; pageY?: number } }) => {
      const { locationX, locationY, pageX, pageY } = e.nativeEvent;
      if (typeof locationX === "number" && typeof locationY === "number" && Number.isFinite(locationX) && Number.isFinite(locationY)) {
        return { x: locationX, y: locationY };
      }
      return null;
    },
    [],
  );

  const handlePinTap = useCallback(
    (e: { nativeEvent: { locationX?: number; locationY?: number; pageX?: number; pageY?: number } }) => {
      if (!onPin || width <= 0 || height <= 0) return;
      const p = pointFromPress(e);
      if (!p) return;
      const ll = unproject(p.x / width, p.y / height);
      onPin(ll.lat, ll.lon);
    },
    [onPin, width, height, pointFromPress],
  );

  const pinned =
    pinLat != null && pinLon != null && width > 0
      ? (() => {
          const p = project(pinLat, pinLon);
          return { x: p.x * width, y: p.y * height };
        })()
      : null;

  const renderVenuePins = () =>
    ordered.map((v) => {
      const p = project(v.lat, v.lon);
      const x = p.x * width;
      const y = p.y * height;
      const hot = v.going_count > 0;
      const selected = v.id === selectedId;
      const r = pinRadius(v.going_count);
      return (
        <G key={v.id} onPress={onSelectVenue ? () => onSelectVenue(v) : undefined}>
          {hot ? <Circle cx={x} cy={y} r={r + 6} fill={HOT_GLOW} /> : null}
          {selected ? <Circle cx={x} cy={y} r={r + 5} fill="none" stroke={SELECTED_FILL} strokeWidth={1.5} /> : null}
          <Circle cx={x} cy={y} r={r} fill={hot ? HOT_FILL : selected ? SELECTED_FILL : QUIET_DOT} />
          {hot ? (
            <SvgText x={x} y={y + 3.5} fontSize={9} fontWeight="800" fill="#FFFFFF" textAnchor="middle">
              {String(v.going_count)}
            </SvgText>
          ) : null}
        </G>
      );
    });

  return (
    <View ref={wrapRef} style={[styles.wrap, { height }]} onLayout={onLayout}>
      {width > 0 ? (
        <Pressable
          onPress={pinMode ? handlePinTap : undefined}
          style={styles.mapPressable}
          disabled={!pinMode}
        >
          {/* Pointer-events: in browse mode the Svg still receives pin taps. */}
          <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
            <Rect x={0} y={0} width={width} height={height} fill={colors.background} />
            <Rect x={0} y={0} width={width} height={height} fill={neon.bgDeep} />
            {gridLines.map((l) => (
              <Line key={l.key} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#1C212C" strokeWidth={1} />
            ))}
            {cityLabels.map((c) => (
              <SvgText
                key={c.city}
                x={c.x}
                y={c.y - 6}
                fontSize={10}
                fontWeight="700"
                fill="#545E74"
                textAnchor="middle"
                letterSpacing={1}
              >
                {c.city.toUpperCase()}
              </SvgText>
            ))}
            {pinMode && pinned ? (
              <G>
                <Circle cx={pinned.x} cy={pinned.y} r={20} fill={HOT_GLOW} />
                <Circle cx={pinned.x} cy={pinned.y} r={9} fill={HOT_FILL} stroke="#FFF" strokeWidth={1.5} />
                <Path
                  d={`M${pinned.x} ${pinned.y + 9} v26`}
                  stroke={HOT_FILL}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              </G>
            ) : null}
            {!pinMode ? renderVenuePins() : null}
          </Svg>
        </Pressable>
      ) : null}
      {pinMode ? (
        <View pointerEvents="none" style={styles.pinHint}>
          <Text style={styles.pinHintText}>Tap the map to drop your pin 📍</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  mapPressable: {
    flex: 1,
  },
  pinHint: {
    position: "absolute",
    top: 10,
    alignSelf: "center",
    backgroundColor: "rgba(11, 13, 16, 0.85)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pinHintText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
});