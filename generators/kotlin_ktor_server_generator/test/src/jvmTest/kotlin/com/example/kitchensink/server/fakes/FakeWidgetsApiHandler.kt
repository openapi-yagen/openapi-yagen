package com.example.kitchensink.server.fakes

import com.example.kitchensink.server.Circle
import com.example.kitchensink.server.Shape
import com.example.kitchensink.server.Square
import com.example.kitchensink.server.Widget
import com.example.kitchensink.server.Widgets
import com.example.kitchensink.server.WidgetsApiHandler
import com.example.kitchensink.server.WidgetsApiListWidgetsStatus

// Hand-written fake implementation of the generated WidgetsApiHandler interface.
class FakeWidgetsApiHandler : WidgetsApiHandler {
    private val widgets = mutableListOf<Widget>()

    private val shapes: Map<String, Shape> = mapOf(
        "circle-1" to Circle(radius = 2.5),
        "square-1" to Square(side = 4.0),
    )

    override suspend fun listWidgets(status: WidgetsApiListWidgetsStatus?, id: String?, xClientVersion: String?): Widgets =
        widgets.toList()

    override suspend fun createWidget(body: Widget): Widget {
        widgets.add(body)
        return body
    }

    override suspend fun getShape(shapeId: String): Shape =
        shapes[shapeId] ?: throw NotFoundException("shape $shapeId not found")
}
