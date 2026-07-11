#!/bin/bash
set -e

# ExcaliDash PWA Docker publisher.
# Builds the frontend and backend images with custom-SSL support and pushes
# them to a public Docker registry under the "excalidash-pwa" image name.
#
# Usage:
#   ./scripts/publish-docker-pwa.sh                 # build + push (version from VERSION, also :latest)
#   ./scripts/publish-docker-pwa.sh 1.2.3          # build + push a specific version
#   ./scripts/publish-docker-pwa.sh --no-push      # build only, do not push
#
# Env:
#   DOCKER_USERNAME  Docker Hub / registry account that owns the images (required)
#   PLATFORMS        Override buildx platforms (default: linux/amd64,linux/arm64)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

IMAGE_NAME="excalidash-pwa"
VERSION=""
PUSH=1

for arg in "$@"; do
    case "$arg" in
        --no-push)
            PUSH=0
            ;;
        -h|--help)
            echo "Usage: $0 [--no-push] [VERSION]"
            echo "  VERSION defaults to contents of the VERSION file."
            echo "  --no-push builds images locally without pushing."
            exit 0
            ;;
        *)
            VERSION="$arg"
            ;;
    esac
done

if [ -z "$VERSION" ]; then
    VERSION=$(node -e "try { console.log(require('fs').readFileSync('VERSION', 'utf8').trim()) } catch { console.log('latest') }")
fi

if [ -z "$DOCKER_USERNAME" ]; then
    echo "ERROR: DOCKER_USERNAME env var is required."
    echo "Set it to your Docker Hub username, e.g.:"
    echo "  export DOCKER_USERNAME=yourhubname"
    exit 1
fi

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILD_FRONTEND_CONTEXT="."

echo "ExcaliDash PWA Docker builder"
echo "  Registry account : $DOCKER_USERNAME"
echo "  Image name prefix : $IMAGE_NAME"
echo "  Version           : $VERSION"
echo "  Platforms         : $PLATFORMS"
echo "  Push              : $([ "$PUSH" = "1" ] && echo yes || echo no)"

if [ "$PUSH" = "1" ]; then
    echo "Checking Docker registry authentication..."
    if ! docker info 2>/dev/null | grep -q "Username:"; then
        echo "Not logged in. Please log in to your registry:"
        docker login
    else
        echo "Already logged in."
    fi
fi

echo "Setting up buildx builder..."
if ! docker buildx inspect excalidash-pwa-builder > /dev/null 2>&1; then
    echo "Creating new buildx builder..."
    docker buildx create --name excalidash-pwa-builder --use --bootstrap
else
    docker buildx use excalidash-pwa-builder
fi

PUSH_FLAG=""
if [ "$PUSH" = "1" ]; then
    PUSH_FLAG="--push"
else
    PUSH_FLAG="--load"
    # --load only supports a single platform; force native platform for local builds.
    PLATFORMS="linux/$(docker info --format '{{.Architecture}}' 2>/dev/null || echo amd64)"
    echo "  (local build) platforms -> $PLATFORMS"
fi

echo "Building backend image..."
docker buildx build \
    --platform "$PLATFORMS" \
    --tag "$DOCKER_USERNAME/$IMAGE_NAME-backend:$VERSION" \
    $( [ "$PUSH" = "1" ] && echo "--tag $DOCKER_USERNAME/$IMAGE_NAME-backend:latest" ) \
    --file backend/Dockerfile \
    $PUSH_FLAG \
    backend/

echo "Backend image built successfully."

echo "Building frontend image..."
docker buildx build \
    --platform "$PLATFORMS" \
    --tag "$DOCKER_USERNAME/$IMAGE_NAME-frontend:$VERSION" \
    $( [ "$PUSH" = "1" ] && echo "--tag $DOCKER_USERNAME/$IMAGE_NAME-frontend:latest" ) \
    --build-arg VITE_APP_VERSION="$VERSION" \
    --build-arg VITE_APP_BUILD_LABEL="pwa-ssl" \
    --file frontend/Dockerfile \
    $PUSH_FLAG \
    "$BUILD_FRONTEND_CONTEXT"

echo "Frontend image built successfully."
echo "Done. Images:"
echo "  $DOCKER_USERNAME/$IMAGE_NAME-backend:$VERSION"
echo "  $DOCKER_USERNAME/$IMAGE_NAME-frontend:$VERSION"
[ "$PUSH" = "1" ] && echo "  (also tagged :latest)"
