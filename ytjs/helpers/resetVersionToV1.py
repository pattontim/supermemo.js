import os
import json

# Define the path to the root directory
root_dir = '../../dist/archive'

# Iterate over all subdirectories in the root directory
for dir_path, dir_names, file_names in os.walk(root_dir):
    # Check if the current directory contains 'info.json'
    if 'info.json' in file_names:
        # Load the JSON data from 'info.json'
        info_json_path = os.path.join(dir_path, 'info.json')
        with open(info_json_path, 'r', encoding='utf-8') as file:
            data = json.load(file)

        # Set the 'version' key to 1
        data['version'] = 1

        # Write the updated JSON data back to 'info.json'
        with open(info_json_path, 'w') as file:
            json.dump(data, file, indent=2)