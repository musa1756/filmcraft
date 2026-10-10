// Verified recipes (FilmCraft 0.5.0). Keep each topic short: it is read by an agent, not a person.

export const GUIDE = {
  overview: `FILMCRAFT MCP — how to work cheaply
1. fc_app → status line (launches the app with --control if needed).
2. fc_project / fc_seq → ids: items i<N>, clips #<N>, transitions T#<N>, captions cap#<N>.
3. Do edits with fc_batch (many steps, one call; then:"seq" returns the new timeline). Single edit: fc_run.
4. Look: fc_frame (one rendered frame) / fc_sheet (whole cut in one image) / fc_shot (UI).
5. Unknown command? fc_find "words" (never list everything). Exact signature: fc_help.
6. Effect/param names: fc_effects "blur" (params+ranges), fc_clip <id> (what a clip has).
Time: ticks = 254016000000/s. Write key_s (seconds, frame-snapped) or key_f (frames) in any params: {"time_s":3}.
Most commands act on the selection unless you pass clips:[ids] / clip:id / items:[ids].
Undo: edit.undo / edit.redo; history.list. Save: file.save / file.saveAs {path}.
Topics: project, edit, trim, motion, color, audio, text, captions, effects, export, ui, ai.`,

  project: `PROJECT & SEQUENCES
file.newProject {name}  (replaces the open project; save first: file.saveAs {path:"/abs/x.fcproj"})
file.open {path} · file.save · file.saveAs {path}
file.import {paths:["/abs/a.mp4",…], bin?} → {items:[ids]}   (video, audio, stills; imageSequence:true for numbered stills)
file.newSequence {name, width, height, fps, sampleRate?, video:n, audio:n} → {sequence:id}
  vertical reel: width 1080 height 1920 fps 30 · YouTube: 1920x1080 fps 25/30 · square 1080x1080
file.newSequenceFromClip {items:[id]} (settings from the clip) · sequence.open {item} (switch active sequence)
sequence.settings {width,height,fps,name,…} · sequence.addTracks {video:n, audio:n}
file.newColorMatte {color:"#rrggbb", seconds} / file.newBlackVideo / file.newAdjustmentLayer {seconds} → project items
file.newBin {name} · project.moveToBin · clip.rename {clip|item, name}`,

  edit: `PLACING & ARRANGING
Fast rough cut: fc_append {clips:[{item:1,in:2,dur:3},{item:2,dur:4}], track:"V1", transition?:"cross_dissolve", fill?:true}
timeline.place {item, track:"V1", audioTrack?:"A1", time_s, sourceIn_s?, duration_s?, insert?:false, video?:true, audio?:true} → {clips:[videoId, audioId]}
  music/VO only: {item, track:"A2", time_s:0, duration_s:30}  (an audio track as track = sound only)
  picture only: video:true,audio:false
timeline.move {moves:[{clip, track:"V2", time_s}], insert?} — linked audio follows; OVERWRITES what is at the destination.
timeline.razor {time_s, track?:"V1", clip?} — with track: only that track; omit to cut targeted tracks.
sequence.addEdit {time_s} / sequence.addEditAllTracks {time_s} — cut every targeted / all tracks at time.
edit.rippleDelete {clips:[ids]} (closes the gap; linked audio goes too) · edit.clear {clips} (leaves a gap)
sequence.closeGap {track:"V1", time_s} · sequence.lift / sequence.extract (In→Out range; markers.markIn/markOut {time_s})
edit.copy / edit.paste / edit.pasteInsert / edit.duplicate (selection) · timeline.select {clips:[ids]}
clip.nest {name} (selection) · clip.link/clip.ungroup · clip.enable {clips} (toggle)
clip.speedDuration {clips, speed:200 (percent), reverse?, ripple?:true, interpolation?:"opticalFlow"}
clip.frameHold {clips, time_s} · clip.insertFrameHoldSegment · timeline.rateStretch {clip, edge, delta}
clip.fillFrame {clips} (scale to cover, e.g. 16:9 in 9:16) · clip.fitToFrame {clips} (letterbox)
clip.sceneEditDetection {clips, applyCuts:true} — auto cuts at shot changes
markers.add {time_s, name, color:"Rose|Green|Mango|Cerulean|…", comment?, durationFrames?}`,

  trim: `TRIMMING (all frame-accurate; delta in ticks or deltaFrames)
timeline.trim {clip, edge:"in|out", mode:"regular|ripple", deltaFrames:-10}  (+ extends, − shortens; ripple shifts later clips)
timeline.roll {left, right, deltaFrames} — move a cut point between two clips
timeline.slip {clip, deltaFrames} — change source in/out, keep position · timeline.slide {clip, deltaFrames}
trim.extendToPlayhead / Q,W keys: trim.ripplePrevious / trim.rippleNext (to playhead)
Direction (verified): edge "in" + positive deltaFrames = cut frames off the START; edge "out" + negative = cut off the END.
  e.g. drop the first 0.5 s at 30 fps: {clip, edge:"in", mode:"ripple", deltaFrames:15}
SYNC LOCK: a ripple edit fails ("would break sync: A2 is sync-locked…") when a music bed spans the cut.
  Fix once per sequence: timeline.setTrack {track:"A2", syncLock:false} (or lock the track: locked:true).`,

  motion: `MOTION, OPACITY, KEYFRAMES
Static: effects.setParam {clip, effect:"motion", param:"scale"|"position"|"rotation"|"anchor", value} (position [x,y] in sequence pixels, centre = [w/2,h/2])
        effects.setParam {clip, effect:"opacity", param:"opacity", value:50} · param "blend" value "Multiply"/"Screen"/… (name or index)
Animate (one call): fc_keys {clip, effect:"motion", param:"scale", keys:[[0,100],[3,115]], ease:"bezier"}   — keys are SEQUENCE seconds
  Ken Burns: scale 100→115 + position drift · fade in: fc_keys opacity [[t0,0],[t0+0.5,100]] · pop-in title: scale [[t,0],[t+0.2,110],[t+0.3,100]]
  NOTE: plain effects.setParam with time on a non-animated param just sets a static value (no keyframe) — use fc_keys.
Keyframe edits: effects.setInterpolation {clip,effect,param,mediaTime,interpolation} · effects.deleteKeyframe · effects.toggleAnimation (off = removes all)
Crop: effects.apply {clips, effect:"crop"} then setParam left/top/right/bottom (percent).
Transform effect (with shutter-angle motion blur): effect "transform".
Masks: masks.add {clip, effect:"opacity", shape:"ellipse", center:[x,y], size:[w,h]} · masks.set {feather, inverted}`,

  color: `COLOR (Lumetri)
Presets (fastest): lumetri.presets → folders Cinematic / Film Emulation / Monochrome / Technical; e.g. "Teal Shadows, Warm Skin", "Golden Dusk", "Night Exterior", "Steel Blue", "Hard Sun", "Faded Print", "Silver Retention"
  lumetri.applyPreset {name, clips:[ids]}
Manual: effects.apply {clips, effect:"lumetri"} then effects.setParam {clip, effect:"lumetri", param, value}:
  basic: temperature tint (-100..100) exposure (-5..5) contrast highlights shadows whites blacks (-100..100) saturation (0..200, 100 = none)
  creative: look (choice) look_intensity faded_film sharpen vibrance creative_sat shadow_tint/highlight_tint ("#rrggbb")
  curves: curve_luma/curve_red/curve_green/curve_blue = [[0,0],[0.25,0.21],[0.75,0.82],[1,1]] (S-curve) · hue_vs_sat …
  wheels: wheel_shadows/midtones/highlights [x,y] (-1..1) + *_l lightness · vignette_amount (-5..5) vignette_feather
  hsl: hsl_on true, hsl_hue, hsl_hue_range, hsl_sat … (secondary correction)
Match: lumetri.applyMatch {clip, referenceTime_s}. LUT: lumetri.setLook {clip, path:"/abs/x.cube"}.
Same grade on many clips: apply to one, edit.copy, select others, edit.pasteAttributes {clips, effects:true}; or an adjustment layer (file.newAdjustmentLayer → place on V2 over the range → lumetri on it).
B&W: preset folder Monochrome, saturation 0, or effect black_white. Check with fc_frame.`,

  audio: `AUDIO
Clip gain: clip.audioGain {clips, mode:"set|adjust|normalizeMax|normalizeAll", db}
Volume (animatable, dB): effects.setParam {clip, effect:"volume", param:"level", value:-6}; fades: fc_keys volume.level [[t,-60],[t+1,0]]
  or audio transitions: sequence.applyAudioTransition {clip, effect:"constant_power", frames:15} (crossfade / fade at edges)
Track: timeline.setTrack {track:"A2", muted?, solo?, volumeDb?, pan?, locked?}
Essential Sound: essentialSound.setType {clips, type:"dialogue|music|sfx|ambience"}
  essentialSound.set {clips, values:{"ducking.enabled":true,"ducking.against":["dialogue"],"ducking.reduceDb":-15,"ducking.fadeS":0.8}}
  essentialSound.generateDucking {clips:[musicClip]} → volume keyframes under dialogue (tag dialogue clips first)
  repair: values {"repair.noise.on":true,"repair.noise.amount":5} · loudness: essentialSound.autoMatch {clips}
  presets: essentialSound.applyPreset {clips, preset, type}
Audio effects: fc_effects kind:"Audio" (55: EQ, compressor, reverb, denoise, …) then effects.apply/setParam.
Mixer: mixer.inspect · mixer.setStrip {strip:"A1", volume, pan, mute, solo}.
Unlink/link picture and sound: clip.link {clips} (toggles). Place one side only with video:false / audio:false.`,

  text: `TITLES & GRAPHICS
Text: playhead.set {seconds} then graphics.newText {text, size:120, seconds:3, position?:[x,y], box?:[w,h]} → {clip, layer:0}
  (point text starts at the position, so centre it:) graphics.set {clip, layer:0, props:{align:"center"}} + graphics.alignFrame.hcenter {clip, layers:[0]}
Style: graphics.set {clip, layer, props:{font:"Inter", font_style:"Bold", size, fill_color:"#ffcc00", stroke:true, stroke_color, stroke_width:8,
  background:true, background_color, background_opacity, background_radius, shadow:true, shadow_blur, tracking, leading, position:[x,y], scale, rotation, opacity}}
  Fonts: any installed system font family (fonts.list is long; use known names: Inter, Helvetica Neue, Arial, Montserrat if installed).
Edit text: graphics.setText {clip, layer, text} · per-character: graphics.setCharStyle {clip, layer, start, end, style:{color, bold, size}}
Shapes: graphics.newRectangle/newEllipse {position, size, clip?(add to existing graphic)} then graphics.set props fill_color…
Animate title: fc_keys on effect "graphic_text" params position/scale/opacity, or wrap with motion/opacity keys.
Roll/crawl credits: graphics.setRoll {clip, mode:"roll"}.
Templates: graphics.template.list {query?} → e.g. builtin:lower-third-slab (controls name, role, slab_color, accent_color, text_color, font)
  graphics.template.apply {template:"builtin:lower-third-slab", values:{name:"…", role:"…"}, time_s, track?} → {clip}
  graphics.template.set {clip, values:{…}}. Templates are 16:9 canvases; they scale into vertical sequences.
Image/logo overlay: graphics.newFromFile {path, time_s} (places above clips at time).
Text lands on the first free video track above; move with timeline.move.`,

  captions: `CAPTIONS / SUBTITLES
captions.add {text, seconds, durationSeconds:3, track?:"C1"} → {caption}  (creates C1 if needed; any language/Unicode)
captions.setText {caption, text} · captions.setTimes · captions.split / merge / delete · captions.list {track}
Style (whole track): captions.setStyle {track:"C1", font, size:64, color:"#ffffffff", background:false, backgroundColor:"#000000bf",
  outline:4, outlineColor, align:"center", anchor:"top|middle|bottom", margin:0.08, lineSpacing}
From a transcript: transcript.generate {items, model:"whisper-base", language:"auto"} (downloads the speech model once: transcript.downloadModel)
  → transcript.createCaptions {maxChars:32, lines:2} · transcript.removePauses / removeFillers (text-based editing)
Import/export: captions.import {path:".srt"} · captions.export {path:"x.srt"}. Burn in on export: settings burnCaptions:true.
Bigger "TikTok style" words: use graphics.newText per phrase instead of captions.`,

  effects: `EFFECTS & TRANSITIONS
Find: fc_effects "blur" / "glow" / "key" / kind:"VideoTransition"
Apply: effects.apply {clips:[ids], effect:"gaussian_blur"} (id or display name) · effects.setParam {clip, effect:"gaussian_blur", param:"blurriness", value:30}
Remove/disable: effects.remove {clip, index} · effects.toggleEnabled {clip, index} (index from fc_clip)
Video transitions: ~110 (fc_effects kind:"VideoTransition")
  sequence.applyVideoTransition {clip, effect, frames:15, edge:"in|out", params?} (edge in = between the previous clip and this one)
  sequence.setTransition {transition:T#id, params, reverse} · default: effects.setDefaultTransition
Popular: gaussian_blur, directional_blur, zoom_blur, lens_blur, sharpen, lumetri, crop, transform, drop_shadow, ultra_key (green screen), track_matte, warp_stabilizer,
  posterize_time, echo, tint, black_white, noise, glow, vignette, rgb_split, glitch, camera_shake, lens_flare, lens_distortion, chroma_leak, film_roll
Transitions: cross_dissolve dip_to_black dip_to_white film_dissolve push slide wipe band_slide clock_wipe radial_wipe iris_round iris_box cross_zoom cube_spin page_peel gradient_wipe
Presets: presets.list / presets.apply {name, clips}.`,

  export: `EXPORT
fc_export {path:"/abs/out.mp4", opts:{format:"h264"}} — waits, returns duration/size/codecs (ffprobe).
  opts: preset (export.presets.list {query:"H.264"}: "Match Source – Adaptive High Bitrate", "High Quality 1080p HD", "High Quality 2160p 4K", YouTube/Vimeo…),
  format h264|hevc|prores|dnxhr|gif|png|wav…, width/height/fps, bitrateKbps, bitrateMode, range, audio:true, settings:{burnCaptions:true, effects:{loudness:{enabled:true,target_lufs:-14}}}
  Social loudness: -14 LUFS (YouTube/Instagram/TikTok).
Frame grab: file.exportFrame {path:"/abs/f.png", time_s} · Captions: captions.export {path}
Interchange: file.exportInterchange {format:"xml|fcpxml|edl|otio|aaf", path}
Check the result: fc_sheet / fc_frame before export; probe after.`,

  ui: `UI DRIVING (only when no command exists)
fc_ui {action:"elements", prefix:"timeline."} → ids + rects. Common ids: tools.Razor, timeline.clip.<id>, timeline.track.V1.lock, project.item.<id>,
  effects.item.<effectId>, panel.tab.Timeline, program.transport.playback.toggle, header.mode.export, lumetri.switch.<section>
fc_ui click {id} / drag {from:{id}, to:{x,y}} / key {key:"Cmd+K"} / type {text}
fc_ui set {state:{workspace:"Color"|"Editing"|"Effects"|"Audio", tool:"Razor", mode:"Edit"|"Export", timeline:{fit:true}}}
fc_ui panel {name:"Lumetri"} · playback {play:"toggle"} · inspect (dialog open? tool? playhead)
fc_shot {panel:"Timeline"|"Program"|…} to see. Menu commands not in the engine are still runnable by id (fc_find marks them [ui]).`,

  ai: `AUTOMATION FEATURES
Transcribe: transcript.models → transcript.downloadModel {model:"whisper-base"} (one-time download) → transcript.generate {items:[id], language:"auto"}
  transcript.inspect / search {query} → text-based edits: transcript.extract/lift {from, to} (word indices), removePauses {minSeconds:0.6}, removeFillers
Scene detection: clip.sceneEditDetection {clips, applyCuts:true, generateMarkers?}
Auto edit to music markers: clip.automateToSequence {items, placement:"unnumberedMarkers"}
Voice-over recording: audio.voiceover.start/stop (needs a mic). Text-to-speech is not in the installed 0.5.0 build.
Lumetri auto match: lumetri.applyMatch · Essential Sound autoMatch (loudness).`,
};

export const GUIDE_TOPICS = Object.keys(GUIDE);
