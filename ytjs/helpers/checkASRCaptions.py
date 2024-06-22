import os
import json

# Set the path to the parent directory of the dist/archive folders
parent_dir = os.path.abspath('../../dist/archive')

foundOnlyAlignStartPos = 0
foundCaptionsJA = 0
foundASRPairs = 0
foundASROnly = 0
verifiedASR = 0
for folder in os.listdir(parent_dir):
    folder_path = os.path.join(parent_dir, folder)
    if os.path.isdir(folder_path):
        # Load the info.json file
        info_json_path = os.path.join(folder_path, 'info.json')
        if os.path.exists(info_json_path):
            with open(info_json_path, 'r', encoding='utf-8') as f:
                info_data = json.load(f)
            
            # Print the version property
            print(f"Version: {info_data['version']}")
            
            # Check for caption tracks with vss_id ".ja" or "a.ja"
            caption_tracks = info_data.get('captions', {}).get('caption_tracks', [])
            ja_tracks = [track for track in caption_tracks if track['vss_id'] in ['.ja', 'a.ja']]

            # if len([track for track in caption_tracks if track["vss_id"] in ['a.ja']]) > 0:
            if len(ja_tracks) > 0:
                foundCaptionsJA += 1
                ja_vtt_path = os.path.join(folder_path, 'captions', 'ja.vtt')
                if os.path.exists(ja_vtt_path):
                    with open(ja_vtt_path, 'r', encoding='utf-8') as f:
                        ja_vtt_content = f.read()
                    if 'align:start position:0%' in ja_vtt_content:
                        foundOnlyAlignStartPos += 1
                    else:
                        pass
                else:
                    print(f"File {ja_vtt_path} not found")

            if(len(ja_tracks) == 1 and ja_tracks[0]["vss_id"]== "a.ja"):
                foundASROnly += 1
                pass
            
            if len(ja_tracks) == 2:
                foundASRPairs += 1
                # Check the ja.vtt file for the string "align:start position:0%"
                if 'align:start position:0%' in ja_vtt_content:
                    verifiedASR += 1
                    print(f"Found 'align:start position:0%' in {ja_vtt_path}")
                else:
                    pass
            else:
                print("No two caption tracks with vss_id '.ja' or 'a.ja' found")
            
            print()  # Print an empty line for better readability

print(f"Found {foundCaptionsJA} videos with Japanese captions")
print(f"Found {foundASRPairs} videos with pair manual+ASR captions")
print(f"Found {foundASROnly} videos with only ASR captions")
print(f"Verified ASR captions for {verifiedASR} videos")
print(f"Found {foundOnlyAlignStartPos} videos with only 'align:start position:0%' in Japanese captions")



