import os
import shutil

# Define the path to the root directory
root_dir = '../../dist/archive'

# Iterate over all subdirectories in the root directory
print("Iterating over all subdirectories in the root directory...", root_dir)
for dir_path, dir_names, file_names in os.walk(root_dir):
    print("Current directory:", dir_path)
    # Check if the current directory contains 'info_old0.json'
    if 'info_old0.json' in file_names:
        # Overwrite 'info.json' with 'info_old0.json'
        print("Overwriting 'info.json' with 'info_old0.json'...")
        src_file = os.path.join(dir_path, 'info_old0.json')
        dst_file = os.path.join(dir_path, 'info.json')
        shutil.copy(src_file, dst_file)

        # del the src_file
        os.remove(src_file)

    # Check if the current directory contains a 'caption' subdirectory
    caption_dir = os.path.join(dir_path, 'captions')
    if os.path.isdir(caption_dir):
        print("Caption directory found:", caption_dir)
        # Iterate over files in the 'caption' subdirectory
        for file_name in os.listdir(caption_dir):
            if file_name.endswith('_v1.vtt'):
                print(f"File '{file_name}' found")
                # Remove the '_v1.vtt' suffix and overwrite the file
                src_file = os.path.join(caption_dir, file_name)
                dst_file = os.path.join(caption_dir, file_name[:-8] + '.vtt')
                shutil.copy(src_file, dst_file)

                # del the src_file
                os.remove(src_file)

            elif(file_name.startswith("a.")):
                # del the file
                print(f"File '{file_name}' found")
                os.remove(os.path.join(caption_dir, file_name))