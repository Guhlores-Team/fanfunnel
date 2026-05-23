# Available Tools — Agent Runtime

## image_generation
Generates images via OpenAI gpt-image-1.
Use for: video thumbnails, product cover images, social post visuals.
Key params: prompt (str), filename (str), size ("1024x1024" | "1024x1792" | "1792x1024")

## audio_generation
Generates speech via OpenAI TTS.
Voices: nova (energetic female), onyx (deep male), alloy, echo, fable, shimmer.
Use for: video voiceovers, audio clips.
Key params: text (str), filename (str), voice (str)

## assemble_video
Combines audio + images into a finished MP4. Call this as the final step of every video task.
Key params: audio_path (str), image_paths (list[str]), output_filename (str)

## save_video_package
Saves finished video + script to workspace/social/ready-to-post/.
Use for: completed video ready for upload/posting.
Key params: title (str), script (str), video_path (str)

## file_editor
Reads and writes files in the project workspace.
Use for: saving drafts, outputs, notes, reading task context.
Key params: operation ("read"|"write"), path (str), content (str, write only)

## create_task
Creates new task files for other agents to pick up.
Use for: Atlas spawning tasks, agents creating follow-up work.
Key params: title, body, assigned_agent, task_type, pod, priority

## web_research
Fetches and summarises content from a URL.
Use for: research, competitor analysis, trending topics.
Key params: url (str), query (str)

## etsy_listing
Creates or updates an Etsy product listing.
Use for: Market agent publishing prompt packs.
Key params: title, description, price, tags, images
