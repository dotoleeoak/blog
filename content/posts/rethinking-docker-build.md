---
title: Rethinking Docker build by Bazel
date: 2025-12-04
description: Compare Dockerfile and rules_oci approaches to build container images.
---

Docker has become the de facto standard for containerization, and Dockerfiles are the most common way to define how to build Docker images.
However, Dockerfiles have some limitations, especially when it comes to managing complex builds and dependencies.
Other approaches, such as Buildah or Podman's Containerfile, also exist but use very similar syntax and concepts to Dockerfiles.

Bazel, a powerful build tool developed by Google, offers an alternative way to build Docker images using the `rules_oci` extension.
In this article, we'll compare the traditional Dockerfile approach with Bazel's `rules_oci` approach, highlighting possible improvements beyond Dockerfiles.

## Limitations of Dockerfiles

Let's start with a simple example of a Dockerfile that builds a Docker image:

```Dockerfile
FROM ubuntu:24.04

WORKDIR /app

# Install apt dependencies for the C++ application
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    libasio-dev \
    libboost-all-dev \
    libopencv-dev \
    libpqxx-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy the current directory contents into the container at /app
COPY . /app

# Build the C++ application
RUN mkdir build && cd build && \
    cmake .. && \
    make

# Set the entrypoint to run the application
ENTRYPOINT ["./build/hello-world"]
```

This Dockerfile starts from the `ubuntu:24.04` base image, installs necessary dependencies, copies the application source code into the container, builds the application, and sets the entrypoint to run the application.
While this approach is straightforward, if the application grows in complexity, the Dockerfile can become unwieldy and hard to maintain.

First of all, let's review how Docker image builder's caching mechanism works.
Docker builds images in layers, where each instruction in the Dockerfile creates a new layer.
In the example above, `RUN` and `COPY` instructions create layers, which are three layers in total.
Unless the following invalidation conditions are met, Docker reuses the cached layers from previous builds to speed up the build process:

- If the instruction itself changes (e.g., modifying the `RUN` command).
- If any files copied by a `COPY` or `ADD` instruction change.

### Problem 1: Optimistic caching unless instruction changes

Now let's check the first layer, which installs apt dependencies.
To invalidate the cache of this layer, the second condition cannot be met because  the `COPY . /app` instruction comes after the `RUN apt-get ...` instruction.
Therefore, the only way to invalidate the cache of this layer is to modify the `RUN` instruction itself.
Unless, the cache will be reused and the apt dependencies will not be updated, even if there are new versions available.
**This can lead to non-reproducible builds, where the same Dockerfile produces different images depending on when the build is performed.**

This kind of issue is common in Dockerfiles, where installed dependencies vary frequently and the exact same Dockerfile does not guarantee reproducibility.
The reproducibility in software build is crucial for ensuring that the same source code always produces the same output, regardless of when or where the build is performed.
However, Dockerfiles can lead to non-reproducible builds due to their caching mechanism and layer management.
This is kind of contradictory, because Docker itself is for reproducible containerization.

To mitigate this issue, one common practice is to explicitly specify the versions of the apt dependencies to be installed.
Let's consider this modified Dockerfile:

```Dockerfile
...

# Copy the text files containing the list of apt dependencies and their versions
COPY apt-dependencies.txt /app/apt-dependencies.txt

# Install apt dependencies for the C++ application
RUN apt-get update && xargs -a /app/apt-dependencies.txt apt-get install -y \
    && rm -rf /var/lib/apt/lists/*
...
```

Here, we introduce a new text file `apt-dependencies.txt` that lists the apt dependencies along with their specific versions.
By copying this file into the container before the `RUN apt-get ...` instruction, we ensure that any changes to the dependencies or their versions will invalidate the cache of this layer.
The `apt-dependencies.txt` would look like this:

```
build-essential=12.9ubuntu3
cmake=3.27.5-0ubuntu1
git=2.41.0-1ubuntu0.1
libasio-dev=1.24.1-1
...
```

This approach improves reproducibility by explicitly specifying the versions of the dependencies.
However, this method still does not fully solve the caching issue.
For example, if we change a single line in `apt-dependencies.txt`, such as updating the version of `cmake`, Docker will invalidate the entire layer that installs all apt dependencies.
This means that even if only one dependency changes, all dependencies will be reinstalled, leading to longer build times.
Also this approach requires manual maintenance of the `apt-dependencies.txt` file, which can be error-prone and cumbersome as the number of dependencies grows.

This example illustrates a problem of Dockerfile's optimistic caching mechanism.
Contrary, let's consider how Docker's pessimistic caching makes another problem.

### Problem 2: Pessimistic caching with large layers

Let's revisit the conditions for Docker layer cache invalidation mentioned earlier.
In the Dockerfile example above, the `COPY . /app` instruction copies the entire application source code into the container.
This means that any change to any file in the source code will invalidate the cache of this layer.
**As a result, even a minor change to a single source file will cause Docker to rebuild the entire layer, which can be time-consuming for large codebases.**

Instead of putting all source files into a single layer, we could break down the `COPY` instruction into multiple instructions, each copying a smaller subset of files.

```Dockerfile
...
# Copy only the source files for package foo
COPY src/foo/ /app/src/foo/

# Build only package foo
RUN cd /app/src/foo && cmake . && make

# Copy only the source files for package bar
COPY src/bar/ /app/src/bar/

# Build only package bar
RUN cd /app/src/bar && cmake . && make
...
```

This approaches improves caching granularity, allowing Docker to reuse cached layers for unchanged packages.
However, this still does not fully solve the problem, because of Docker's linear layer structure.
Even with multiple `COPY` and `RUN` instructions, Docker builds layers sequentially.
Since package `foo` is built before package `bar`, any change to the source files of package `foo` will invalidate the cache of the layer that builds package `bar`, even if package `bar` itself has not changed.
This can be solved by Docker's multi-stage builds.

```Dockerfile
# Stage 1: Build package foo
FROM ubuntu:24.04 AS build-foo
WORKDIR /app
COPY src/foo/ /app/src/foo/
RUN cd /app/src/foo && cmake . && make

# Stage 2: Build package bar
FROM ubuntu:24.04 AS build-bar
WORKDIR /app
COPY src/bar/ /app/src/bar/
RUN cd /app/src/bar && cmake . && make

# Stage 3: Create final image
FROM ubuntu:24.04

WORKDIR /app

# Install apt dependencies for the C++ application
RUN apt-get update && ...

# Copy built packages from previous stages
COPY --from=build-foo /app/src/foo/build/ /app/src/foo/build/
COPY --from=build-bar /app/src/bar/build/ /app/src/bar/build/

...
```

In this multi-stage build, we create separate build stages for each package.
This allows Docker to build and cache each package independently.
However, this approach does not scale well as the number of packages increases.
What if there are 500 packages?
Are we going to create 500 build stages in the Dockerfile?
This quickly becomes unmanageable and defeats the purpose of using Dockerfiles for simplicity.

Other popular build tools for Docker images, such as Buildah and Podman, also use similar layer-based caching mechanisms.
Therefore, they share the same limitations as Dockerfiles when it comes to caching and layer management.

## Bazel basics

Before diving into the comparison of Dockerfile and Bazel, let's briefly review some Bazel concepts.
Bazel uses `BUILD.bazel` files to define build targets, which can include libraries, binaries, and container images.
Let's take a look at a simple example of a C++ binary.
Consider the following file structure:

```
srcs/
├── BUILD.bazel
├── hello_greet.cc
├── hello_greet.h
└── hello_world.cc
libs/
├── BUILD.bazel
├── hello_time.cc
└── hello_time.h
```

The `BUILD.bazel` file in the `srcs/` directory might look like this:

```python
load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_library")

cc_library(
    name = "hello_greet",
    srcs = ["hello_greet.cc"],
    hdrs = ["hello_greet.h"],
)

cc_binary(
    name = "hello_world",
    srcs = ["hello_world.cc"],
    deps = [
        ":hello_greet",
        "//libs:hello_time",
    ],
)
```

In this example, we define a C++ library `hello-greet` and a binary `hello-world` that depends on it.
`srcs` specifies the source files, and `deps` lists the dependencies.
`hello-greet` and `hello-world` are called 'targets' in Bazel, which can be built using Bazel commands.

```sh
# Build the hello-greet library
bazel build //srcs:hello-greet

# Build the hello-world binary, automatically building its dependencies
bazel build //srcs:hello-world
```

If you want to learn more about Bazel, I'd recommend starting with [official tutorial](https://bazel.build/start/cpp).

## OCI image format

Before diving into Bazel's approach to building Docker images, it's important to understand the OCI (Open Container Initiative) image format.
There was Docker image format initially, but it has been standardized as OCI image format to ensure compatibility across different container runtimes.
OCI image consists of a few key components:

- **Layers**: Similar to Docker layers, OCI images are built in layers, where each layer represents a set of filesystem changes. Layers are stacked on top of each other to form the final image.
- **Manifests**: The manifest is a JSON document that describes the image, including its layers, configuration, and other metadata.
- **Configuration**: The configuration contains information about how the container should be run, such as environment variables, entrypoints, and command arguments.

OCI image is basically a tarball containing these components, which can be pushed to and pulled from container registries.
File structure of an OCI image tarball looks like this:

```
oci-image/
├── index.json     # entry point for the OCI image
├── manifest.json  # image manifest (JSON)
└── blobs/
    ├── sha256/
    │   ├── <hash-of-manifest>  # image manifest (JSON)
    │   ├── <hash-of-config>    # image config (JSON)
    │   ├── <hash-of-layer-1>   # layer 1 tarball (tar.gz)
    │   ├── <hash-of-layer-2>   # layer 2 tarball (tar.gz)
    │   └── ...
    └── ...
```

The `index.json` file points to the manifest under `blobs/sha256/`, which in turn points to the layers and configuration.

The main thing to note here is that each layer is stored as a separate gzipped tarball under `blobs/sha256/`.

## Building Docker images with Bazel

There are numerous rules for Bazel, such as `rules_cc` for C++ and `rules_python` for Python.
For building Docker images, we can use `rules_oci`, which provides rules to create OCI-compliant container images.
Let's see how we can define a Docker image using `rules_oci`.

The following part demonstrates the following working example.
If you want to try it out, check the repository at the link below.

GitHub: https://github.com/dotoleeoak/dockerfile-vs-bazel

We are going to expand the previous C++ example to build a Docker image containing the `hello_world` binary.
First, we need to add `rules_oci` and `rules_pkg` in `MODULE.bazel` file, which contains project-level dependencies.
`rules_pkg` is another Bazel extension that provides packaging rules, which we will use to create tarballs for OCI layers.

```python
bazel_dep(name = "rules_oci", version = "2.2.7")
bazel_dep(name = "rules_pkg", version = "1.1.0")
```

This lets Bazel know that we want to use `rules_oci` and `rules_pkg` as dependencies, just like how pip or npm pulls in packages.

After adding these dependencies, we can pull base images from remote registries for our OCI image.
In this example, we will use the `debian` base image.
The following snippet in `MODULE.bazel` pulls the `debian:13.2` image from Docker Hub.

```python
oci = use_extension("@rules_oci//oci:extensions.bzl", "oci")
oci.pull(
    name = "debian",
    digest = "sha256:8f6a88feef3ed01a300dafb87f208977f39dccda1fd120e878129463f7fa3b8f",
    image = "debian",
    platforms = [
        "linux/amd64",
        "linux/arm64/v8",
    ],
    tag = "13.2",
)
use_repo(oci, "debian", "debian_linux_amd64", "debian_linux_arm64_v8")```
```

Here, we define a repository named `debian` using the `oci.pull` function from `rules_oci`.
For reproducibility, we specify the exact digest of the image along with the tag.
The `platforms` attribute specifies the target platforms for the image, allowing us to build multi-platform images.

Next, we are going to add some targets in the `BUILD.bazel` under `srcs/` directory, reusing the previous C++ targets.

```python
load("@rules_pkg//pkg:tar.bzl", "pkg_tar")

pkg_tar(
    name = "layer",
    srcs = [":hello_world"],
    package_dir = "/app",
)
```

Here, we define a target named `layer` using the `pkg_tar` rule from `rules_pkg`.
`pkg_tar` creates a tarball containing the specified source files.
This tarball will be used as a layer in our OCI image.
The `srcs` attribute specifies the files to include in the tarball, which is the `hello_world` binary in this case.
The `package_dir` attribute specifies the directory inside the container where the files will be placed, which is `/app` in this case.
In this case, this `layer` target would put the `hello_world` binary into `/app/hello_world` inside the container.

Finally, we define the OCI image target using `oci_image` rule from `rules_oci`.

```python
load("@rules_oci//oci:defs.bzl", "oci_image")

oci_image(
    name = "image",
    base = "@debian",
    entrypoint = ["/app/hello_world"],
    tars = [":layer"],
)
```

The base image is set to the previously pulled `debian` image in `MODULE.bazel`.
The `entrypoint` attribute is same as the `ENTRYPOINT` instruction in Dockerfile, specifying the command to run when the container starts.
The `tars` attribute specifies the list of tarballs to include as layers in the OCI image, which is the `layer` target we defined earlier.
Each tarball in `tars` will be added as a separate layer in the OCI image.

With these definitions in place, we can build the OCI image using Bazel:

```sh
bazel build //srcs:image
```

Furthermore, we can load the built OCI image into Docker daemon with `oci_load` rule.

```python
load("@rules_oci//oci:defs.bzl", "oci_load")

oci_load(
    name = "load_image",
    image = ":image",
    repo_tags = ["hello_world:bazel"],
)
```

This `oci_load` target loads the built OCI image into Docker daemon with the specified tag `hello_world:bazel`.
We can build and load the image with the following command:

```sh
bazel run //srcs:load_image
```

Now we can run the container using Docker:

```sh
docker run --rm hello_world:bazel
```

Let's revisit the second problem of Dockerfile's pessimistic caching with large layers.
The main issue was that even a minor change to a single source file would cause Docker to rebuild the single huge layer or all subsequent layers.
In the Bazel approach, since each layer is defined as a separate target (e.g., `pkg_tar` target) instead of linear `COPY`/`RUN` instructions, the dependencies between these targets can be managed more intelligently.
If we change the source code of `hello_world.cc`, even if there are multiple layers in `tars` attribute of `oci_image` rule, only the `layer` target is rebuilt, and other layers remain cached.
This is because Bazel tracks the dependencies between targets and only rebuilds the affected targets.

So two approaches can be taken with Bazel to improve caching granularity:

- Put several artifacts into a single `pkg_tar` target to create a layer.
- Split artifacts into multiple `pkg_tar` targets to create multiple layers.

Either way, Bazel's dependency tracking ensures that only the necessary layers are rebuilt when source files change.
Even for the first approach, where multiple artifacts are bundled into a single layer, Bazel can still optimize the build process by only rebuilding the affected targets.
This is far more efficient and scalable than Dockerfile's linear layer structure.

### Installing external dependencies with Bazel

The example above uses the `debian` base image, which is a minimal Linux distribution.
However, in real-world applications, we often need to install external dependencies, such as apt packages.
Well, it's doable with Bazel as well, but usually this is not the 'bazel way'.
Let me demonstrate how apt dependencies are handled first, and then discuss what the 'bazel way' is.

Usually, not using base image is preferred in Bazel ecosystem for minimality and reproducibility.
Minimal stacks, like passwd or ca-certificates, are built from ground up using `rules_distroless`, just like `distroless` images in Docker ecosystem.
`rules_distroless` provides helper rules to replace commands like `apt-get` or `passwd`, `groupadd`, etc.
We are going to use `debian` base image for focusing on apt dependencies in this case, without going into details of `rules_distroless`.

Just like other rules, we are going to add `rules_distroless` in `MODULE.bazel` file.

```python
bazel_dep(name = "rules_distroless", version = "0.6.1")
```

Then, we can use `apt.install` rule from `rules_distroless` to install apt dependencies.
To use this, we need to define a special YAML manifest file and a lockfile for apt dependencies.
Here's an example YAML manifest file for apt packages, named `trixie.yaml` this time.

```yaml
version: 1

sources:
  - channel: trixie main
    url: https://deb.debian.org/debian
  - channel: trixie-security main
    url: https://security.debian.org/debian-security

archs:
  - "amd64"
  - "arm64"

packages:
  - "tzdata"
  - "bash"
  - "coreutils"
  - "grep"
```

This manifest file specifies the apt sources, target architectures, and the list of packages to install.
Next, let's add `apt.install` rule in `MODULE.bazel` to let Bazel read this manifest and create a lockfile.

```python
apt = use_extension(
    "@rules_distroless//apt:extensions.bzl",
    "apt",
    dev_dependency = True,
)
apt.install(
    name = "trixie",
    lock = "//apt:trixie.lock.json", # path to the lockfile to be generated
    manifest = "//apt:trixie.yaml",  # path to the manifest file
)
use_repo(apt, "trixie")
```

Next, let's generate the lockfile using the following command:

```sh
touch apt/trixie.lock.json  # create an empty lockfile first
bazel run @trixie//:lock    # generate the lockfile
```

This command generates the lockfile `trixie.lock.json` based on the manifest file.
The lockfile contains the exact versions of the packages and checksums for reproducibility.
Now `rules_distroless` would create repositories for each package specified in the lockfile, like `@trixie//tzdata`, `@trixie//bash`, etc.

Finally, we can modify the `oci_image` target defined earlier, adding these apt packages as layers.

```python
oci_image(
    name = "image",
    base = "@debian",
    entrypoint = ["/app/hello_world"],
    tars = [
        ":layer",
        "@trixie//tzdata",
        "@trixie//bash",
        ...
    ],
)
```

Now let's go back to the first problem of Dockerfile's caching.
Using apt or other package managers in Dockerfiles often leads to non-reproducible builds and caching issues.
With Bazel's approach, since each apt package is defined as a separate target, the dependencies between these targets can be managed more intelligently.
Updating a single package in the lockfile will only rebuild the corresponding target, while other packages remain cached.
Also `rules_distroless` forces us to use lockfiles, which improves reproducibility by ensuring that the same versions of packages are installed every time.

However, in personal opinion, this approach is a bit out of Bazel's philosophy.
Bazel is designed to build software from source code, managing dependencies at the source level.
Installing pre-built binary packages, like apt packages, loses track of the fine-grained dependency tree that Bazel excels at.
This is not always the problem, but loosen dependency management would hide potential issues and abandon minimality.

The 'bazel way' would be to build all dependencies from source using Bazel itself, ensuring full visibility and control over the dependency graph.
This would make extremely painful to port third-party libraries, since BUILD files have to be manually written for each of them.
There are hard efforts around [Bazel Central Registry (BCR)](https://registry.bazel.build/) to share BUILD files for popular libraries, but still very far from complete.
I think this is the biggest barrier to adopting Bazel, since Bazel is originally designed for Google, where third-party dependencies rarely exist and all code resides in a single monorepo.

## Bazel might not be the best tool

While Bazel offers a powerful way to build software, introducing it into an existing project is a huge undertaking.
Dockerfile and Bazel have very different philosophies and approaches to building Docker images, so migrating from Dockerfile to Bazel requires significant effort.
Especially using third-party dependencies with Bazel is a big challenge, as mentioned earlier.
I am witnessing Bazel community is trying hard to improve the ecosystem, but it seems today's Bazel hinders productivity compared to existing tools.

The point of this article is not to suggest introducing Bazel into every project, but to rethink the limitations of Dockerfiles.
There are useful tools that overcome some of Dockerfile's limitations, such as Jib and nix2container.
nix2container uses Nix package manager to build Docker images, leveraging Nix's reproducibility and dependency management.
I have not tried nix2container yet, but it seems promising to solve the problems.
Ultimately, the choice of build tool depends on the specific needs and constraints of your project.
