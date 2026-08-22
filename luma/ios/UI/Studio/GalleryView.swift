import SwiftUI

/// Everything that has been generated, as a grid.
///
/// Its own screen rather than the bottom half of 创作台. A grid inside a form is
/// fighting the form — the list wants rows and the grid wants the whole width —
/// and on a server that has generated nothing it left the composer trailing off
/// into an empty page.
struct GalleryView: View {
    @Environment(AppModel.self) private var app
    @State private var inspecting: GeneratedAsset?

    private var store: StudioStore { app.studio }

    /// Adaptive rather than a fixed column count, so an iPad shows more instead
    /// of the same two columns stretched to the width of a page.
    private let columns = [GridItem(.adaptive(minimum: 108), spacing: Space.sm)]

    var body: some View {
        ScrollView {
            if store.gallery.isEmpty {
                ContentUnavailableView(
                    "还没有作品",
                    systemImage: "photo.on.rectangle.angled",
                    description: Text("在创作台生成的图和视频都会留在这里。")
                )
                .padding(.top, 80)
            } else {
                LazyVGrid(columns: columns, spacing: Space.sm) {
                    ForEach(store.gallery) { asset in
                        Button { inspecting = asset } label: {
                            GalleryTile(asset: asset)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(Space.md)

                if store.gallery.count < store.galleryTotal {
                    // Loads by appearing rather than by a button: there is nothing
                    // to decide, and a tap target at the end of a grid is a tap
                    // target people scroll past.
                    HStack { Spacer(); Spinner(); Spacer() }
                        .padding(.vertical, Space.lg)
                        .task { await store.loadMoreGallery() }
                }
            }
        }
        .background(Color.bg)
        .navigationTitle("图库")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if store.galleryTotal > 0 {
                ToolbarItem(placement: .topBarTrailing) {
                    Text("\(store.galleryTotal) 件")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .refreshable { await store.load() }
        .sheet(item: $inspecting) { asset in AssetDetailView(asset: asset) }
    }
}

/// A square tile. Square on purpose: a masonry grid of mixed aspect ratios reads
/// as clutter at thumbnail size, and the detail sheet is one tap away for anyone
/// who wants to see the real shape.
private struct GalleryTile: View {
    let asset: GeneratedAsset

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                Group {
                    if asset.kind == .video {
                        VideoPoster(poster: asset.poster, width: 320, contentMode: .fill)
                    } else {
                        AuthedImage(imageId: ImageId(asset.assetId), width: 320, contentMode: .fill)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.md))
            .overlay(alignment: .bottomTrailing) {
                if asset.kind == .video {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.white, .black.opacity(0.4))
                        .padding(6)
                }
            }
    }
}
