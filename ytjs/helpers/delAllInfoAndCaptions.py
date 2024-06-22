import os
import shutil

# Define the path to the root directory
root_dir = '../../dist/archive'

# Iterate over all subdirectories in the root directory
print("Iterating over all subdirectories in the root directory...", root_dir)
for dir_path, dir_names, file_names in os.walk(root_dir):
    print("Current directory:", dir_path)
    
    
    if 'info.json' in file_names:
        src_file = os.path.join(dir_path, 'info.json')
        if os.path.isfile(src_file):
            os.remove(src_file)
    if 'info_old0.json' in file_names:
        src_file = os.path.join(dir_path, 'info_old0.json')
        if os.path.isfile(src_file):
            os.remove(src_file)
    if 'info_old1.json' in file_names:
        src_file = os.path.join(dir_path, 'info_old1.json')
        if os.path.isfile(src_file):
            os.remove(src_file)
    if 'info_old2.json' in file_names:
        src_file = os.path.join(dir_path, 'info_old2.json')
        if os.path.isfile(src_file):
            os.remove(src_file)

    # Check if the current directory contains a 'caption' subdirectory
    caption_dir = os.path.join(dir_path, 'captions')
    if os.path.isdir(caption_dir):
        print("Caption directory found:", caption_dir)
        # Iterate over files in the 'caption' subdirectory
        for file_name in os.listdir(caption_dir):
            os.remove(os.path.join(caption_dir, file_name))