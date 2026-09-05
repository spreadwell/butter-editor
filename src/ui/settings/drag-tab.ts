import { Platform, requireApiVersion, Setting } from "obsidian";
import type { SliderComponent } from "obsidian";
import { ButterSettingTab } from "../settings-tab";
import { tx } from "../../i18n";
import {
  DRAG_COMPACTION_TRIGGER_MAX_PX,
  DRAG_COMPACTION_TRIGGER_MIN_PX,
  DRAG_COMPACTED_HEIGHT_MAX_PX,
  DRAG_COMPACTED_HEIGHT_MIN_PX,
  DRAG_TRIGGER_OFFSET_MAX_PX,
  DRAG_TRIGGER_OFFSET_MIN_PX,
  DEFAULT_CONTAINER_DRAG_TRIGGER_OFFSET_PX,
  DEFAULT_DRAG_COMPACTION_TRIGGER_PX,
  DEFAULT_DRAG_COMPACTED_HEIGHT_PX,
  DEFAULT_DRAG_TRIGGER_OFFSET_PX,
} from "../../editor/drag-handles/constants";

/** Obsidian 1.13.1 renders slider values inline. Older supported builds still
 * need the legacy hover tooltip, so call it only on that compatibility path. */
function enableLegacySliderValue(slider: SliderComponent): SliderComponent {
  if (requireApiVersion("1.13.1")) return slider;
  const legacy = slider as unknown as {
    setDynamicTooltip?: () => unknown;
  };
  legacy.setDynamicTooltip?.();
  return slider;
}

type SliderChangeHandler = (value: number) => void | Promise<void>;

/** Mobile range controls otherwise claim a vertical page-scroll gesture and
 * jump to the touched coordinate before the browser knows the user's intent.
 * Delay persistence until release and restore the pickup value as soon as a
 * vertical gesture is recognized. Horizontal drags and deliberate taps retain
 * normal native-slider behavior. */
function wireScrollSafeSlider(
  slider: SliderComponent,
  onChange: SliderChangeHandler,
): SliderComponent {
  enableLegacySliderValue(slider);
  if (!Platform.isMobile) {
    slider.onChange((value) => void onChange(value));
    return slider;
  }

  slider.setInstant(false);
  const input = slider.sliderEl;
  input.addClass("butter-settings-scroll-safe-slider");
  type GestureIntent = "pending" | "horizontal" | "vertical";
  let gesture: {
    pointerId: number;
    startX: number;
    startY: number;
    startValue: number;
    intent: GestureIntent;
  } | null = null;
  let suppressReleaseChange = false;

  const restorePickupValue = () => {
    if (gesture) slider.setValue(gesture.startValue);
  };
  const suppressCurrentRelease = () => {
    suppressReleaseChange = true;
    input.ownerDocument.defaultView?.setTimeout(() => {
      suppressReleaseChange = false;
    }, 0);
  };

  input.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startValue: slider.getValue(),
      intent: "pending",
    };
  }, { capture: true });

  input.addEventListener("pointermove", (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const deltaX = Math.abs(event.clientX - gesture.startX);
    const deltaY = Math.abs(event.clientY - gesture.startY);
    if (gesture.intent === "pending" && Math.max(deltaX, deltaY) >= 6) {
      gesture.intent = deltaY > deltaX ? "vertical" : "horizontal";
    }
    if (gesture.intent === "vertical") restorePickupValue();
  }, { capture: true });

  const finishGesture = (event: PointerEvent, cancelled: boolean) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (cancelled || gesture.intent === "vertical") {
      restorePickupValue();
      suppressCurrentRelease();
    }
    gesture = null;
  };
  input.addEventListener("pointerup", (event: PointerEvent) => {
    finishGesture(event, false);
  }, { capture: true });
  input.addEventListener("pointercancel", (event: PointerEvent) => {
    finishGesture(event, true);
  }, { capture: true });

  slider.onChange((value) => {
    if (suppressReleaseChange || gesture?.intent === "vertical") return;
    void onChange(value);
  });
  return slider;
}

function addSliderReset(
  setting: Setting,
  reset: () => void | Promise<void>,
): void {
  setting.addExtraButton((button) => button
    .setIcon("rotate-ccw")
    .setTooltip(tx("Reset"))
    .onClick(() => void reset()));
}

export function renderDragSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName(tx("Motion"))
      .setDesc(tx("Drag animation feel. Springy bounces; Snappy is direct; Smooth is steady."))
      .addDropdown((d) =>
        d
          .addOptions({
            springy: tx("Springy"),
            snappy: tx("Snappy"),
            smooth: tx("Smooth"),
          })
          .setValue(this.plugin.settings.dragMotion)
          .onChange(async (v) => {
            this.plugin.settings.dragMotion = v as "springy" | "snappy" | "smooth";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName(tx("Handle visibility"))
      .setDesc(tx("When the gutter drag handle appears. Hover: only on the pointed-at block. Always: stays on the nearest block."))
      .addDropdown((d) =>
        d
          .addOptions({
            hover: tx("On hover"),
            always: tx("Always"),
          })
          .setValue(this.plugin.settings.dragHandleVisibility)
          .onChange(async (v) => {
            this.plugin.settings.dragHandleVisibility = v as "hover" | "always";
            await this.plugin.saveSettings();
          }),
      );

    let triggerOffsetSlider: SliderComponent | null = null;
    const triggerOffsetSetting = new Setting(root)
      .setName(tx("Reflow trigger offset"))
      .setDesc(tx("Adjusts reflow relative to the dragged block's exact destination. 0 is exact; positive is earlier; negative is later."))
      .addSlider((s) => {
        triggerOffsetSlider = s;
        wireScrollSafeSlider(
          s
          .setLimits(DRAG_TRIGGER_OFFSET_MIN_PX, DRAG_TRIGGER_OFFSET_MAX_PX, 1)
          .setValue(this.plugin.settings.blockDragTriggerOffsetPx),
          async (v) => {
            this.plugin.settings.blockDragTriggerOffsetPx = v;
            await this.plugin.saveSettings();
          },
        );
      });
    addSliderReset(triggerOffsetSetting, async () => {
      this.plugin.settings.blockDragTriggerOffsetPx = DEFAULT_DRAG_TRIGGER_OFFSET_PX;
      triggerOffsetSlider?.setValue(DEFAULT_DRAG_TRIGGER_OFFSET_PX);
      await this.plugin.saveSettings();
    });

    let containerOffsetSlider: SliderComponent | null = null;
    const containerOffsetSetting = new Setting(root)
      .setName(tx("Callout and quote reflow offset"))
      .setDesc(tx("Adjusts reflow when crossing or entering callouts and quote blocks. 0 is exact; positive is earlier; negative is later."))
      .addSlider((s) => {
        containerOffsetSlider = s;
        wireScrollSafeSlider(
          s
          .setLimits(DRAG_TRIGGER_OFFSET_MIN_PX, DRAG_TRIGGER_OFFSET_MAX_PX, 1)
          .setValue(this.plugin.settings.blockDragContainerTriggerOffsetPx),
          async (v) => {
            this.plugin.settings.blockDragContainerTriggerOffsetPx = v;
            await this.plugin.saveSettings();
          },
        );
      });
    addSliderReset(containerOffsetSetting, async () => {
      this.plugin.settings.blockDragContainerTriggerOffsetPx =
        DEFAULT_CONTAINER_DRAG_TRIGGER_OFFSET_PX;
      containerOffsetSlider?.setValue(DEFAULT_CONTAINER_DRAG_TRIGGER_OFFSET_PX);
      await this.plugin.saveSettings();
    });

    let compactionTriggerSlider: SliderComponent | null = null;
    let compactedHeightSlider: SliderComponent | null = null;
    const compactionTriggerSetting = new Setting(root)
      .setName(tx("Compaction trigger height"))
      .setDesc(tx("Dragged content taller than this uses a compact preview."))
      .addSlider((s) => {
        compactionTriggerSlider = s;
        wireScrollSafeSlider(
          s
          .setLimits(
            DRAG_COMPACTION_TRIGGER_MIN_PX,
            DRAG_COMPACTION_TRIGGER_MAX_PX,
            20,
          )
          .setValue(this.plugin.settings.dragCompactionTriggerPx),
          async (v) => {
            this.plugin.settings.dragCompactionTriggerPx = v;
            if (this.plugin.settings.dragCompactedHeightPx > v) {
              this.plugin.settings.dragCompactedHeightPx = v;
            }
            compactedHeightSlider
              ?.setLimits(
                DRAG_COMPACTED_HEIGHT_MIN_PX,
                Math.min(DRAG_COMPACTED_HEIGHT_MAX_PX, v),
                4,
              )
              .setValue(this.plugin.settings.dragCompactedHeightPx);
            await this.plugin.saveSettings();
          },
        );
      });
    addSliderReset(compactionTriggerSetting, async () => {
      this.plugin.settings.dragCompactionTriggerPx =
        DEFAULT_DRAG_COMPACTION_TRIGGER_PX;
      if (this.plugin.settings.dragCompactedHeightPx > DEFAULT_DRAG_COMPACTION_TRIGGER_PX) {
        this.plugin.settings.dragCompactedHeightPx = DEFAULT_DRAG_COMPACTION_TRIGGER_PX;
      }
      compactionTriggerSlider?.setValue(DEFAULT_DRAG_COMPACTION_TRIGGER_PX);
      compactedHeightSlider
        ?.setLimits(
          DRAG_COMPACTED_HEIGHT_MIN_PX,
          DEFAULT_DRAG_COMPACTION_TRIGGER_PX,
          4,
        )
        .setValue(this.plugin.settings.dragCompactedHeightPx);
      await this.plugin.saveSettings();
    });

    const compactedHeightSetting = new Setting(root)
      .setName(tx("Compacted preview height"))
      .setDesc(tx("Height of the compact drag preview. It can be smaller than the trigger height."))
      .addSlider((s) => {
        compactedHeightSlider = s;
        wireScrollSafeSlider(
          s
          .setLimits(
            DRAG_COMPACTED_HEIGHT_MIN_PX,
            Math.min(
              DRAG_COMPACTED_HEIGHT_MAX_PX,
              this.plugin.settings.dragCompactionTriggerPx,
            ),
            4,
          )
          .setValue(this.plugin.settings.dragCompactedHeightPx),
          async (v) => {
            this.plugin.settings.dragCompactedHeightPx = Math.min(
              v,
              this.plugin.settings.dragCompactionTriggerPx,
            );
            await this.plugin.saveSettings();
          },
        );
      });
    addSliderReset(compactedHeightSetting, async () => {
      this.plugin.settings.dragCompactedHeightPx = DEFAULT_DRAG_COMPACTED_HEIGHT_PX;
      compactedHeightSlider?.setValue(DEFAULT_DRAG_COMPACTED_HEIGHT_PX);
      await this.plugin.saveSettings();
    });
  }
