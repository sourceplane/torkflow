# Torkflow Assets

This directory contains static assets and configuration files that are bundled with the torkflow provider.

## Directory Structure

- **config/** - Configuration templates and examples
- **actionStore/** - Action store definitions and examples
- **examples/** - Workflow example files

## Usage

These assets are included in the provider artifact when packaged as an OCI image. They provide:

- Template workflows for common use cases
- Action store configurations
- Provider configuration examples

## Distribution

Assets are included in the `core` layer of the Thin provider manifest (`thin.provider.yaml`) with the media type:
- `application/vnd.sourceplane.assets.v1`

All files under `assets/**` are automatically included in the provider artifact.
