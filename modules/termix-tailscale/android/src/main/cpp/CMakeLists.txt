cmake_minimum_required(VERSION 3.22.1)

project(termix_ts_jni)

# JNI bridge over the Go tsnet library (libtermix_ts.so, prebuilt per ABI).
add_library(termix_ts_jni SHARED termix_ts_jni.c)

# Headers live in jniLibs/ (termix_ts.h); the Go .so lives in jniLibs/<abi>/.
set(JNILIBS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs")
set(ABI_DIR "${JNILIBS_DIR}/${ANDROID_ABI}")

target_include_directories(termix_ts_jni PRIVATE
  "${JNILIBS_DIR}"
  "${ABI_DIR}"
)

if(EXISTS "${ABI_DIR}/libtermix_ts.so")
  target_link_libraries(termix_ts_jni PRIVATE
    "${ABI_DIR}/libtermix_ts.so"
    log
  )
else()
  message(WARNING "libtermix_ts.so missing for ${ANDROID_ABI}; JNI bridge won't link")
endif()
